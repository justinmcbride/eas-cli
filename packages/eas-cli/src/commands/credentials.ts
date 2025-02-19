import { Flags } from '@oclif/core';

import EasCommand from '../commandUtils/EasCommand';
import { SelectPlatform } from '../credentials/manager/SelectPlatform';

export default class Credentials extends EasCommand {
  static override description = 'manage credentials';

  static override flags = {
    platform: Flags.enum({ char: 'p', options: ['android', 'ios'] }),
  };

  async runAsync(): Promise<void> {
    const { flags } = await this.parse(Credentials);
    await new SelectPlatform(flags.platform).runAsync();
  }
}
