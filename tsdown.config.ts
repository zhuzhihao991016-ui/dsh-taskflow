/**
 * dsh-taskflow tsdown config: the node-half lib build plus the browser
 * client bundle, via the shared client-bundle preset copied from the DSH
 * checkout (packages/client/tsdown.client.ts). Keep the preset in sync with
 * the running DSH version.
 */
import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('dsh-taskflow', ['src/index.ts', 'src/invariant.ts'])
