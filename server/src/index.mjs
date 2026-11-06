import { loadConfig } from './config.mjs'
import { buildApp } from './app.mjs'
import { listen } from './http.mjs'
import { withSite } from './site.mjs'
import { withLaunch } from './launch.mjs'
import { prepareSiteJson } from './sitejson.mjs'

let config
try { config = loadConfig() } catch (e) { console.error(`Not starting: ${e.message}`); process.exit(1) }
if (!config.rpcUrl) { console.error('RPC_URL is not set'); process.exit(1) }
// PREVIEW_CHAIN=1 is for local test chain runs only. A production process started with it is a wrong deploy.
if (process.env.PREVIEW_CHAIN === '1') { console.error('Not starting: PREVIEW_CHAIN=1 belongs to the preview test chain only'); process.exit(1) }
try { const s = prepareSiteJson({ config }); if (s.wrote) console.log('site config written to', s.file) } catch (e) { console.error(`Not starting: ${e.message}`); process.exit(1) }
const log = (...a) => console.log(new Date().toISOString(), ...a)
const app = buildApp({ config, log })
await listen(withLaunch(withSite(app, config), app, config), config.port) // the API is up during the rebuild, and reads what it has
log('listening on', config.port)
await app.start()
app.run()
