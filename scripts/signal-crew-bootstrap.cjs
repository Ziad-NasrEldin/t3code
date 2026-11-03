const path = require("node:path");
const os = require("node:os");
const base = path.join(os.homedir(), "Library", "Application Support", "t3code-signal-crew");
process.env.T3CODE_HOME = path.join(base, "home");
process.env.T3CODE_DESKTOP_USER_DATA_DIR = path.join(base, "electron");
process.env.T3CODE_DESKTOP_APP_USER_MODEL_ID = "com.t3tools.t3code.signalcrew";
delete process.env.VITE_DEV_SERVER_URL;
require("./apps/desktop/dist-electron/boot.cjs");
