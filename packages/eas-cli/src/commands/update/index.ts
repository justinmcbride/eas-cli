import { ExpoConfig } from '@expo/config';
import { Updates } from '@expo/config-plugins';
import { Platform, Workflow } from '@expo/eas-build-job';
import { Errors, Flags } from '@oclif/core';
import assert from 'assert';
import chalk from 'chalk';
import dateFormat from 'dateformat';
import gql from 'graphql-tag';
import nullthrows from 'nullthrows';

import { getEASUpdateURL } from '../../api';
import { BRANCHES_LIMIT } from '../../branch/queries';
import { getUpdateGroupUrl } from '../../build/utils/url';
import EasCommand from '../../commandUtils/EasCommand';
import fetch from '../../fetch';
import { graphqlClient, withErrorHandlingAsync } from '../../graphql/client';
import {
  GetUpdateGroupAsyncQuery,
  PublishUpdateGroupInput,
  Robot,
  RootQueryUpdatesByGroupArgs,
  StatuspageServiceName,
  Update,
  UpdateInfoGroup,
  UpdatePublishMutation,
  User,
  ViewBranchUpdatesQuery,
} from '../../graphql/generated';
import { PublishMutation } from '../../graphql/mutations/PublishMutation';
import { BranchQuery } from '../../graphql/queries/BranchQuery';
import { UpdateQuery } from '../../graphql/queries/UpdateQuery';
import Log, { learnMore, link } from '../../log';
import { ora } from '../../ora';
import { getExpoConfig } from '../../project/expoConfig';
import {
  findProjectRootAsync,
  getProjectAccountName,
  getProjectIdAsync,
  installExpoUpdatesAsync,
  isExpoUpdatesInstalledOrAvailable,
} from '../../project/projectUtils';
import {
  PublishPlatform,
  buildBundlesAsync,
  buildUnsortedUpdateInfoGroupAsync,
  collectAssetsAsync,
  isUploadedAssetCountAboveWarningThreshold,
  uploadAssetsAsync,
} from '../../project/publish';
import { resolveWorkflowAsync } from '../../project/workflow';
import { confirmAsync, promptAsync, selectAsync } from '../../prompts';
import { formatUpdate } from '../../update/utils';
import { ensureLoggedInAsync } from '../../user/actions';
import {
  checkManifestBodyAgainstUpdateInfoGroup,
  getCodeSigningInfoAsync,
  getManifestBodyAsync,
  signManifestBody,
} from '../../utils/code-signing';
import uniqBy from '../../utils/expodash/uniqBy';
import formatFields from '../../utils/formatFields';
import { enableJsonOutput, printJsonOnlyOutput } from '../../utils/json';
import { maybeWarnAboutEasOutagesAsync } from '../../utils/statuspageService';
import { getVcsClient } from '../../vcs';
import { createUpdateBranchOnAppAsync } from '../branch/create';
import { createUpdateChannelOnAppAsync } from '../channel/create';

export const defaultPublishPlatforms: PublishPlatform[] = ['android', 'ios'];
export type PublishPlatformFlag = PublishPlatform | 'all';

async function getUpdateGroupAsync({
  group,
}: RootQueryUpdatesByGroupArgs): Promise<GetUpdateGroupAsyncQuery['updatesByGroup']> {
  const { updatesByGroup } = await withErrorHandlingAsync(
    graphqlClient
      .query<GetUpdateGroupAsyncQuery, RootQueryUpdatesByGroupArgs>(
        gql`
          query getUpdateGroupAsync($group: ID!) {
            updatesByGroup(group: $group) {
              id
              group
              runtimeVersion
              manifestFragment
              platform
              message
            }
          }
        `,
        {
          group,
        },
        { additionalTypenames: ['Update'] }
      )
      .toPromise()
  );
  return updatesByGroup;
}

async function ensureChannelExistsAsync({
  appId,
  branchId,
  channelName,
}: {
  appId: string;
  branchId: string;
  channelName: string;
}): Promise<void> {
  try {
    await createUpdateChannelOnAppAsync({
      appId,
      channelName,
      branchId,
    });
    Log.withTick(
      `Created a channel: ${chalk.bold(channelName)} pointed at branch: ${chalk.bold(channelName)}.`
    );
  } catch (e: any) {
    const isIgnorableError =
      e.graphQLErrors?.length === 1 &&
      e.graphQLErrors[0].extensions.errorCode === 'CHANNEL_ALREADY_EXISTS';
    if (!isIgnorableError) {
      throw e;
    }
  }
}

export async function ensureBranchExistsAsync({
  appId,
  name: branchName,
  limit,
  offset,
}: {
  appId: string;
  name: string;
  limit: number;
  offset: number;
}): Promise<{
  id: string;
  updates: Exclude<
    Exclude<ViewBranchUpdatesQuery['app'], null | undefined>['byId']['updateBranchByName'],
    null | undefined
  >['updates'];
}> {
  const { app } = await UpdateQuery.viewBranchAsync({
    appId,
    name: branchName,
    limit,
    offset,
  });
  const updateBranch = app?.byId.updateBranchByName;
  if (updateBranch) {
    const { id, updates } = updateBranch;
    await ensureChannelExistsAsync({ appId, branchId: id, channelName: branchName });
    return { id, updates };
  }

  const newUpdateBranch = await createUpdateBranchOnAppAsync({ appId, name: branchName });
  Log.withTick(`Created branch: ${chalk.bold(branchName)}`);
  await ensureChannelExistsAsync({ appId, branchId: newUpdateBranch.id, channelName: branchName });
  return { id: newUpdateBranch.id, updates: [] };
}

export default class UpdatePublish extends EasCommand {
  static override description = 'publish an update group';

  static override flags = {
    branch: Flags.string({
      description: 'Branch to publish the update group on',
      required: false,
    }),
    message: Flags.string({
      description: 'A short message describing the update',
      required: false,
    }),
    republish: Flags.boolean({
      description: 'Republish an update group',
      exclusive: ['input-dir', 'skip-bundler'],
    }),
    group: Flags.string({
      description: 'Update group to republish',
      exclusive: ['input-dir', 'skip-bundler'],
    }),
    'input-dir': Flags.string({
      description: 'Location of the bundle',
      default: 'dist',
      required: false,
    }),
    'skip-bundler': Flags.boolean({
      description: `Skip running Expo CLI to bundle the app before publishing`,
      default: false,
    }),
    platform: Flags.enum({
      char: 'p',
      options: [...defaultPublishPlatforms, 'all'],
      default: 'all',
      required: false,
    }),
    json: Flags.boolean({
      description: 'Enable JSON output, non-JSON messages will be printed to stderr',
      default: false,
    }),
    auto: Flags.boolean({
      description:
        'Use the current git branch and commit message for the EAS branch and update message',
      default: false,
    }),
    'private-key-path': Flags.string({
      description: `File containing the PEM-encoded private key corresponding to the certificate in expo-updates' configuration. Defaults to a file named "private-key.pem" in the certificate's directory.`,
      required: false,
    }),
    'non-interactive': Flags.boolean({
      default: false,
      description: 'Run command in non-interactive mode',
    }),
  };

  async runAsync(): Promise<void> {
    let {
      flags: {
        branch: branchName,
        json: jsonFlag,
        auto: autoFlag,
        message,
        republish,
        group,
        'input-dir': inputDir,
        'skip-bundler': skipBundler,
        platform,
        'private-key-path': privateKeyPath,
        'non-interactive': nonInteractive,
      },
    } = await this.parse(UpdatePublish);

    if (jsonFlag) {
      enableJsonOutput();
    }

    const platformFlag = platform as PublishPlatformFlag;
    // If a group was specified, that means we are republishing it.
    republish = group ? true : republish;

    const projectDir = await findProjectRootAsync();
    const exp = getExpoConfig(projectDir, {
      isPublicConfig: true,
    });

    const expPrivate = getExpoConfig(projectDir, {
      isPublicConfig: false,
    });

    await maybeWarnAboutEasOutagesAsync([StatuspageServiceName.EasUpdate]);

    const codeSigningInfo = await getCodeSigningInfoAsync(expPrivate, privateKeyPath);

    const hasExpoUpdates = isExpoUpdatesInstalledOrAvailable(projectDir, exp.sdkVersion);
    if (!hasExpoUpdates && nonInteractive) {
      Errors.error(
        `${chalk.bold(
          'expo-updates'
        )} must already be installed when executing in non-interactive mode`,
        { exit: 1 }
      );
    }

    if (!hasExpoUpdates) {
      const install = await confirmAsync({
        message: `You are creating an update which requires ${chalk.bold(
          'expo-updates'
        )} to be installed in your app.\n  Do you want EAS CLI to install it for you?`,
        instructions: 'The command will abort unless you agree.',
      });
      if (install) {
        await installExpoUpdatesAsync(projectDir);
      } else {
        Errors.error(`Install ${chalk.bold('expo-updates')} manually and come back later.`, {
          exit: 1,
        });
      }
    }

    const runtimeVersions = await getRuntimeVersionObjectAsync(exp, platformFlag, projectDir);
    const projectId = await getProjectIdAsync(exp);
    await checkEASUpdateURLIsSetAsync(exp);

    if (!branchName && autoFlag) {
      branchName =
        (await getVcsClient().getBranchNameAsync()) ||
        `branch-${Math.random().toString(36).substr(2, 4)}`;
    }

    if (!branchName) {
      if (nonInteractive) {
        throw new Error('Must supply --branch or use --auto when in non-interactive mode');
      }

      const validationMessage = 'Branch name may not be empty.';
      if (jsonFlag) {
        throw new Error(validationMessage);
      }

      const branches = await BranchQuery.listBranchesAsync({
        appId: projectId,
        limit: BRANCHES_LIMIT,
        offset: 0,
      });
      if (branches.length === 0) {
        ({ name: branchName } = await promptAsync({
          type: 'text',
          name: 'name',
          message: 'No branches found. Provide a branch name:',
          initial:
            (await getVcsClient().getBranchNameAsync()) ||
            `branch-${Math.random().toString(36).substr(2, 4)}`,
          validate: value => (value ? true : validationMessage),
        }));
      } else {
        branchName = await selectAsync<string>(
          'Which branch would you like to publish on?',
          branches.map(branch => {
            return {
              title: `${branch.name} ${chalk.grey(
                `- current update: ${formatUpdate(branch.updates[0])}`
              )}`,
              value: branch.name,
            };
          })
        );
      }
      assert(branchName, 'Branch name must be specified.');
    }

    let unsortedUpdateInfoGroups: UpdateInfoGroup = {};
    let oldMessage: string, oldRuntimeVersion: string;
    let uploadedAssetCount = 0;
    let assetLimitPerUpdateGroup = 0;

    if (republish) {
      // If we are republishing, we don't need to worry about building the bundle or uploading the assets.
      // Instead we get the `updateInfoGroup` from the update we wish to republish.
      let updatesToRepublish: Pick<
        Update,
        'group' | 'message' | 'runtimeVersion' | 'manifestFragment' | 'platform'
      >[];
      if (group) {
        updatesToRepublish = await getUpdateGroupAsync({ group });
      } else {
        if (nonInteractive) {
          throw new Error('Must supply --group when in non-interactive mode');
        }

        // Drop into interactive mode if the user has not specified an update group to republish.
        if (jsonFlag) {
          throw new Error('You must specify the update group to republish.');
        }

        updatesToRepublish = await getUpdatesToRepublishInteractiveAsync(
          projectId,
          branchName,
          platformFlag,
          50
        );
      }
      const updatesToRepublishFilteredByPlatform = updatesToRepublish.filter(
        // Only republish to the specified platforms
        update => platformFlag === 'all' || update.platform === platformFlag
      );
      if (updatesToRepublishFilteredByPlatform.length === 0) {
        throw new Error(
          `There are no updates on branch "${branchName}" published for the platform(s) "${platformFlag}" with group ID "${
            group ? group : updatesToRepublish[0].group
          }". Did you mean to publish a new update instead?`
        );
      }

      let publicationPlatformMessage: string;
      if (platformFlag === 'all') {
        if (updatesToRepublishFilteredByPlatform.length !== defaultPublishPlatforms.length) {
          Log.warn(`You are republishing an update that wasn't published for all platforms.`);
        }
        publicationPlatformMessage = `The republished update will appear on the same plaforms it was originally published on: ${updatesToRepublishFilteredByPlatform
          .map(update => update.platform)
          .join(', ')}`;
      } else {
        publicationPlatformMessage = `The republished update will appear only on: ${platformFlag}`;
      }
      Log.withTick(publicationPlatformMessage);

      for (const update of updatesToRepublishFilteredByPlatform) {
        const { manifestFragment } = update;
        const platform = update.platform as PublishPlatform;

        unsortedUpdateInfoGroups[platform] = JSON.parse(manifestFragment);
      }

      // These are the same for each member of an update group
      group = updatesToRepublishFilteredByPlatform[0].group;
      oldMessage = updatesToRepublishFilteredByPlatform[0].message ?? '';
      oldRuntimeVersion = updatesToRepublishFilteredByPlatform[0].runtimeVersion;

      if (!message) {
        if (nonInteractive) {
          throw new Error('Must supply --message when in non-interactive mode');
        }

        const validationMessage = 'publish message may not be empty.';
        if (jsonFlag) {
          throw new Error(validationMessage);
        }
        ({ publishMessage: message } = await promptAsync({
          type: 'text',
          name: 'publishMessage',
          message: `Provide an update message.`,
          initial: `Republish "${oldMessage!}" - group: ${group}`,
          validate: (value: any) => (value ? true : validationMessage),
        }));
      }
    } else {
      if (!message && autoFlag) {
        message = (await getVcsClient().getLastCommitMessageAsync())?.trim();
      }

      if (!message) {
        if (nonInteractive) {
          throw new Error('Must supply --message or use --auto when in non-interactive mode');
        }

        const validationMessage = 'publish message may not be empty.';
        if (jsonFlag) {
          throw new Error(validationMessage);
        }
        ({ publishMessage: message } = await promptAsync({
          type: 'text',
          name: 'publishMessage',
          message: `Provide an update message.`,
          initial: (await getVcsClient().getLastCommitMessageAsync())?.trim(),
          validate: (value: any) => (value ? true : validationMessage),
        }));
      }

      // build bundle and upload assets for a new publish
      if (!skipBundler) {
        const bundleSpinner = ora().start('Building bundle...');
        try {
          await buildBundlesAsync({ projectDir, inputDir });
          bundleSpinner.succeed('Built bundle!');
        } catch (e) {
          bundleSpinner.fail('Failed to build bundle!');
          throw e;
        }
      }

      const assetSpinner = ora().start('Uploading assets...');
      try {
        const platforms = platformFlag === 'all' ? defaultPublishPlatforms : [platformFlag];
        const assets = await collectAssetsAsync({ inputDir: inputDir!, platforms });
        const uploadResults = await uploadAssetsAsync(
          assets,
          projectId,
          (totalAssets, missingAssets) => {
            assetSpinner.text = `Uploading assets. Finished (${
              totalAssets - missingAssets
            }/${totalAssets})`;
          }
        );
        uploadedAssetCount = uploadResults.uniqueUploadedAssetCount;
        assetLimitPerUpdateGroup = uploadResults.assetLimitPerUpdateGroup;
        unsortedUpdateInfoGroups = await buildUnsortedUpdateInfoGroupAsync(assets, exp);
        const uploadAssetSuccessMessage = uploadedAssetCount
          ? `Uploaded ${uploadedAssetCount} ${uploadedAssetCount === 1 ? 'asset' : 'assets'}!`
          : `Uploading assets skipped -- no new assets found!`;
        assetSpinner.succeed(uploadAssetSuccessMessage);
      } catch (e) {
        assetSpinner.fail('Failed to upload assets');
        throw e;
      }
    }

    const truncatedMessage = truncatePublishUpdateMessage(message!);

    const runtimeToPlatformMapping: Record<string, string[]> = {};
    for (const runtime of new Set(Object.values(runtimeVersions))) {
      runtimeToPlatformMapping[runtime] = Object.entries(runtimeVersions)
        .filter(pair => pair[1] === runtime)
        .map(pair => pair[0]);
    }

    const { id: branchId } = await ensureBranchExistsAsync({
      appId: projectId,
      name: branchName,
      limit: 0,
      offset: 0,
    });

    // Sort the updates into different groups based on their platform specific runtime versions
    const updateGroups: PublishUpdateGroupInput[] = Object.entries(runtimeToPlatformMapping).map(
      ([runtime, platforms]) => {
        const localUpdateInfoGroup = Object.fromEntries(
          platforms.map(platform => [
            platform,
            unsortedUpdateInfoGroups[platform as keyof UpdateInfoGroup],
          ])
        );

        if (republish && !oldRuntimeVersion) {
          throw new Error(
            'Cannot find the runtime version of the update group that is being republished.'
          );
        }
        return {
          branchId,
          updateInfoGroup: localUpdateInfoGroup,
          runtimeVersion: republish ? oldRuntimeVersion : runtime,
          message: truncatedMessage,
          awaitingCodeSigningInfo: !!codeSigningInfo,
        };
      }
    );
    let newUpdates: UpdatePublishMutation['updateBranch']['publishUpdateGroups'];
    const publishSpinner = ora('Publishing...').start();
    try {
      newUpdates = await PublishMutation.publishUpdateGroupAsync(updateGroups);

      if (codeSigningInfo) {
        Log.log('🔒 Signing updates');

        const updatesTemp = [...newUpdates];
        const updateGroupsAndTheirUpdates = updateGroups.map(updateGroup => {
          const newUpdates = updatesTemp.splice(0, Object.keys(updateGroup.updateInfoGroup).length);
          return {
            updateGroup,
            newUpdates,
          };
        });

        await Promise.all(
          updateGroupsAndTheirUpdates.map(async ({ updateGroup, newUpdates }) => {
            await Promise.all(
              newUpdates.map(async newUpdate => {
                const response = await fetch(newUpdate.manifestPermalink, {
                  method: 'GET',
                  headers: { accept: 'multipart/mixed' },
                });
                const manifestBody = nullthrows(await getManifestBodyAsync(response));

                checkManifestBodyAgainstUpdateInfoGroup(
                  manifestBody,
                  nullthrows(
                    updateGroup.updateInfoGroup[newUpdate.platform as keyof UpdateInfoGroup]
                  )
                );

                const manifestSignature = signManifestBody(manifestBody, codeSigningInfo);

                await PublishMutation.setCodeSigningInfoAsync(newUpdate.id, {
                  alg: codeSigningInfo.codeSigningMetadata.alg,
                  keyid: codeSigningInfo.codeSigningMetadata.keyid,
                  sig: manifestSignature,
                });
              })
            );
          })
        );
      }

      publishSpinner.succeed('Published!');
    } catch (e) {
      publishSpinner.fail('Failed to published updates');
      throw e;
    }

    if (jsonFlag) {
      printJsonOnlyOutput(newUpdates);
    } else {
      if (new Set(newUpdates.map(update => update.group)).size > 1) {
        Log.addNewLineIfNone();
        Log.log(
          '👉 Since multiple runtime versions are defined, multiple update groups have been published.'
        );
      }

      Log.addNewLineIfNone();
      for (const runtime of new Set(Object.values(runtimeVersions))) {
        const newUpdatesForRuntimeVersion = newUpdates.filter(
          update => update.runtimeVersion === runtime
        );
        if (newUpdatesForRuntimeVersion.length === 0) {
          throw new Error(`Publish response is missing updates with runtime ${runtime}.`);
        }
        const platforms = newUpdatesForRuntimeVersion.map(update => update.platform);
        const newAndroidUpdate = newUpdatesForRuntimeVersion.find(
          update => update.platform === 'android'
        );
        const newIosUpdate = newUpdatesForRuntimeVersion.find(update => update.platform === 'ios');
        const updateGroupId = newUpdatesForRuntimeVersion[0].group;

        const projectName = exp.slug;
        const accountName = getProjectAccountName(exp, await ensureLoggedInAsync());
        const updateGroupUrl = getUpdateGroupUrl(accountName, projectName, updateGroupId);
        const updateGroupLink = link(updateGroupUrl, { dim: false });

        Log.log(
          formatFields([
            { label: 'Branch', value: branchName },
            { label: 'Runtime version', value: runtime },
            { label: 'Platform', value: platforms.join(', ') },
            { label: 'Update group ID', value: updateGroupId },
            ...(newAndroidUpdate
              ? [{ label: 'Android update ID', value: newAndroidUpdate.id }]
              : []),
            ...(newIosUpdate ? [{ label: 'iOS update ID', value: newIosUpdate.id }] : []),
            { label: 'Message', value: truncatedMessage },
            { label: 'Website link', value: updateGroupLink },
          ])
        );
        Log.addNewLineIfNone();
        if (
          isUploadedAssetCountAboveWarningThreshold(uploadedAssetCount, assetLimitPerUpdateGroup)
        ) {
          Log.warn(
            `This update group contains ${uploadedAssetCount} assets and is nearing the server cap of ${assetLimitPerUpdateGroup}.\n` +
              `${learnMore('https://docs.expo.dev/eas-update/optimize-assets/', {
                learnMoreMessage: 'Consider optimizing your usage of assets',
                dim: false,
              })}.`
          );
          Log.addNewLineIfNone();
        }
      }
    }
  }
}

export async function getUpdatesToRepublishInteractiveAsync(
  projectId: string,
  branchName: string,
  platformFlag: string,
  pageSize: number,
  offset: number = 0,
  cumulativeUpdates: Exclude<
    Exclude<ViewBranchUpdatesQuery['app'], null | undefined>['byId']['updateBranchByName'],
    null | undefined
  >['updates'] = []
): Promise<
  Exclude<
    Exclude<ViewBranchUpdatesQuery['app'], null | undefined>['byId']['updateBranchByName'],
    null | undefined
  >['updates']
> {
  const fetchMoreValue = '_fetchMore';

  const { updates } = await ensureBranchExistsAsync({
    appId: projectId,
    name: branchName,
    limit: pageSize + 1, // fetch an extra item so we know if there are additional pages
    offset,
  });
  cumulativeUpdates = [
    ...cumulativeUpdates,
    // drop that extra item used for pagination from our render logic
    ...updates.slice(0, updates.length - 1),
  ];
  const cumulativeUpdatesForTargetPlatforms =
    platformFlag === 'all'
      ? cumulativeUpdates
      : cumulativeUpdates.filter(update => {
          // Only show groups that have updates on the specified platform(s).
          return update.platform === platformFlag;
        });
  const updateGroups = uniqBy(cumulativeUpdatesForTargetPlatforms, u => u.group).map(update => ({
    title: formatUpdateTitle(update),
    value: update.group,
  }));
  if (updateGroups.length === 0) {
    throw new Error(
      `There are no updates on branch "${branchName}" published for the platform(s) ${platformFlag}. Did you mean to publish a new update instead?`
    );
  }

  if (updates.length > pageSize) {
    updateGroups.push({ title: 'Next page...', value: fetchMoreValue });
  }

  const selectedUpdateGroup = await selectAsync<string>(
    'Which update would you like to republish?',
    updateGroups
  );
  if (selectedUpdateGroup === fetchMoreValue) {
    return await getUpdatesToRepublishInteractiveAsync(
      projectId,
      branchName,
      platformFlag,
      pageSize,
      offset + pageSize,
      cumulativeUpdates
    );
  }
  return cumulativeUpdates.filter(update => update.group === selectedUpdateGroup);
}

async function getRuntimeVersionObjectAsync(
  exp: ExpoConfig,
  platformFlag: PublishPlatformFlag,
  projectDir: string
): Promise<Record<string, string>> {
  const platforms = (platformFlag === 'all' ? ['android', 'ios'] : [platformFlag]) as Platform[];

  for (const platform of platforms) {
    const isPolicy = typeof (exp[platform]?.runtimeVersion ?? exp.runtimeVersion) === 'object';
    if (isPolicy) {
      const isManaged = (await resolveWorkflowAsync(projectDir, platform)) === Workflow.MANAGED;
      if (!isManaged) {
        throw new Error(
          'Runtime version policies are only supported in the managed workflow. In the bare workflow, runtime version needs to be set manually.'
        );
      }
    }
  }

  return Object.fromEntries(
    platforms.map(platform => [
      platform,
      nullthrows(
        Updates.getRuntimeVersion(exp, platform),
        `Unable to determine runtime version for ${platform}`
      ),
    ])
  );
}

function formatUpdateTitle(
  update: Exclude<
    Exclude<ViewBranchUpdatesQuery['app'], null | undefined>['byId']['updateBranchByName'],
    null | undefined
  >['updates'][number]
): string {
  const { message, createdAt, actor, runtimeVersion } = update;

  let actorName: string;
  switch (actor?.__typename) {
    case 'User': {
      actorName = (actor as Pick<User, 'username' | 'id'>).username;
      break;
    }
    case 'Robot': {
      const { firstName, id } = actor as Pick<Robot, 'firstName' | 'id'>;
      actorName = firstName ?? `robot: ${id.slice(0, 4)}...`;
      break;
    }
    default:
      actorName = 'unknown';
  }
  return `[${dateFormat(
    createdAt,
    'mmm dd HH:MM'
  )} by ${actorName}, runtimeVersion: ${runtimeVersion}] ${message}`;
}

async function checkEASUpdateURLIsSetAsync(exp: ExpoConfig): Promise<void> {
  const configuredURL = exp.updates?.url;
  const projectId = await getProjectIdAsync(exp);
  const expectedURL = getEASUpdateURL(projectId);

  if (configuredURL !== expectedURL) {
    throw new Error(
      `The update URL is incorrectly configured for EAS Update. Set updates.url to ${expectedURL} in your ${chalk.bold(
        'app.json'
      )}.`
    );
  }
}

export const truncatePublishUpdateMessage = (originalMessage: string): string => {
  if (originalMessage.length > 1024) {
    Log.warn('Update message exceeds the allowed 1024 character limit. Truncating message...');
    return originalMessage.substring(0, 1021) + '...';
  }
  return originalMessage;
};
