/* electron-builder afterPack:
 * Ad-hoc sign the macOS bundle so Gatekeeper doesn't reject it as
 * "damaged" — identity: null leaves the bundle unsigned, and a
 * quarantined unsigned app cannot be opened on modern macOS.
 * (No standalone-server copy needed here — this app is pure Electron.)
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
    const { appOutDir, packager } = context;

    if (process.platform === 'darwin') {
        const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
        execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
            stdio: 'inherit',
        });
        console.log(`Ad-hoc signed ${appPath}`);
    }
};
