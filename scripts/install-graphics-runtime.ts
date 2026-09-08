import {install,Browser} from "@puppeteer/browsers";
import {resolve} from "node:path";
import {GRAPHIC_CHROME_VERSION} from "../packages/planner/src/motion-graphics";

const cache=process.argv[2];if(!cache)throw new Error("Usage: bun scripts/install-graphics-runtime.ts browser-cache-directory");
const browser=await install({browser:Browser.CHROMEHEADLESSSHELL,buildId:GRAPHIC_CHROME_VERSION,cacheDir:resolve(cache)});
process.stdout.write(browser.executablePath+"\n");
