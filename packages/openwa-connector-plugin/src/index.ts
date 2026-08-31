import { WAStudioConnector } from './connector';

declare const __PLUGIN_VERSION__: string;

const pluginVersion = typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : '0.0.0-dev';

export default class WAStudioOpenWAConnector extends WAStudioConnector {
  constructor() {
    super(pluginVersion);
  }
}
