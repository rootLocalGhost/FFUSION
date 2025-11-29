const { spawn } = require("child_process");
const fs = require("fs-extra");
const path = require("path");

process.env.NODE_NO_WARNINGS = "1";

const colors = {
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
};

function log(step, message) {
  console.log(`${colors.cyan}[${step}]${colors.reset} ${message}`);
}

function getPlatformConfig() {
  switch (process.platform) {
    case "win32":
      return {
        id: "win",
        name: "Windows",
        vendorFolder: "binaries", // FFusion uses 'binaries'
        cliFlag: "--win",
        target: "nsis"
      };
    case "darwin":
      return {
        id: "mac",
        name: "macOS",
        vendorFolder: "binaries",
        cliFlag: "--mac",
        target: "dmg"
      };
    case "linux":
      return {
        id: "linux",
        name: "Linux",
        vendorFolder: "binaries",
        cliFlag: "--linux",
        target: "AppImage"
      };
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

async function executeCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === "win32" && command === "npx" ? "npx.cmd" : command;
    // Fix for [DEP0190]: Manually construct command string
    const fullCommand = [cmd, ...args].map(a => a.includes(" ") ? `"${a}"` : a).join(" ");

    const child = spawn(fullCommand, {
      cwd: cwd,
      shell: true,
      env: { ...process.env, NODE_NO_WARNINGS: 1 }
    });

    let hasLoggedPackaging = false;
    let hasLoggedNSIS = false;

    child.stdout.on("data", (data) => {
      const str = data.toString();
      const lowerStr = str.toLowerCase();

      if (lowerStr.includes("downloading") && !lowerStr.includes("part")) {
        console.log(`   ${colors.gray}↓  Downloading resources...${colors.reset}`);
      } else if (lowerStr.includes("packaging") && !hasLoggedPackaging) {
        console.log(`   ${colors.green}→  Packaging application...${colors.reset}`);
        hasLoggedPackaging = true;
      } else if (lowerStr.includes("nsis") && !hasLoggedNSIS) {
        console.log(`   ${colors.green}→  Building Installer (NSIS)...${colors.reset}`);
        hasLoggedNSIS = true;
      }
    });

    child.stderr.on("data", (data) => {
      const str = data.toString();
      // Suppress non-critical warnings
      if (str.toLowerCase().includes("error") && !str.includes("DeprecationWarning") && !str.includes("postinstall")) {
        console.error(`${colors.red}   [Error] ${str.trim()}${colors.reset}`);
      }
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with code ${code}`));
    });
  });
}

function findInstaller(dir, ext) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isFile() && file.endsWith(ext) && !file.includes("uninstaller") && !file.includes("blockmap")) {
      return { name: file, path: fullPath };
    }
  }
  return null;
}

async function runBuild() {
  const platformConfig = getPlatformConfig();
  const rootDir = __dirname; // Since builder.js is in root
  const releaseDir = path.join(rootDir, "release");
  const finalArtifactDir = path.join(releaseDir, platformConfig.id);

  const iconPath = path.join(rootDir, "assets", "icon.ico");
  const macIconPath = path.join(rootDir, "assets", "icon.png"); // Use png if icns not available
  const linuxIconPath = path.join(rootDir, "assets", "icon.png");
  const tempConfigPath = path.join(rootDir, "temp-build-config.json");

  console.log(colors.cyan + "==================================================" + colors.reset);
  console.log(colors.cyan + "                  FFusion Builder                 " + colors.reset);
  console.log(colors.cyan + "==================================================" + colors.reset);
  console.log(`   Target: ${colors.yellow}${platformConfig.name}${colors.reset}`);

  log("1/4", "Cleanup");
  if (fs.existsSync(releaseDir)) {
    try {
      await fs.remove(releaseDir);
    } catch (e) { }
  }
  console.log(`   ${colors.green}✔ Clean.${colors.reset}`);

  // Skipped Native Rebuild (Step 2 in original) as FFusion relies on external binaries (ffmpeg), not native node modules.

  log("\n2/4", "Packaging (electron-builder)");
  console.log(`   ${colors.gray}→  Generating configuration...${colors.reset}`);

  const buildConfig = {
    appId: "com.siam.ffusion",
    productName: "FFusion",
    copyright: "Copyright © 2025 Md Siam Mia",
    directories: {
      output: "release",
      buildResources: "assets"
    },
    files: [
      "src/**/*",
      "package.json",
      "assets/**/*",
      "!**/node_modules/*/{CHANGELOG.md,README.md,README,readme.md,readme}",
      "!**/node_modules/*/{test,__tests__,tests,powered-test,example,examples}",
      "!**/node_modules/*.d.ts",
      "!**/node_modules/.bin",
      "!binaries/**/*", // Exclude binaries from ASAR, we add them as extraResources
      "!**/.git/**",
      "!**/.github/**",
      "!**/helpers/**"
    ],
    extraResources: [
      {
        from: platformConfig.vendorFolder,
        to: platformConfig.vendorFolder,
        filter: ["**/*"]
      }
    ],
    compression: "maximum",
    asar: true,
    win: {
      target: "nsis",
      icon: iconPath
    },
    nsis: {
      oneClick: false,
      perMachine: true,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: "FFusion",
      uninstallDisplayName: "FFusion",
      runAfterFinish: true,
      deleteAppDataOnUninstall: true,
      installerIcon: iconPath,
      uninstallerIcon: iconPath
    },
    linux: {
      target: "AppImage",
      icon: linuxIconPath,
      category: "Video"
    },
    mac: {
      target: "dmg",
      icon: macIconPath
    }
  };

  await fs.writeJson(tempConfigPath, buildConfig, { spaces: 2 });

  try {
    await executeCommand("npx", ["electron-builder", "--config", "temp-build-config.json", platformConfig.cliFlag], rootDir);
  } catch (e) {
    if (await fs.pathExists(tempConfigPath)) await fs.remove(tempConfigPath);
    throw e;
  }

  if (await fs.pathExists(tempConfigPath)) await fs.remove(tempConfigPath);

  log("\n3/4", "Organizing Artifacts");
  await fs.ensureDir(finalArtifactDir);

  let ext = ".exe";
  if (process.platform === "darwin") ext = ".dmg";
  if (process.platform === "linux") ext = ".AppImage";

  let found = findInstaller(releaseDir, ext);

  if (found) {
    const dest = path.join(finalArtifactDir, found.name);
    try {
      if (path.relative(found.path, dest) !== "") await fs.move(found.path, dest, { overwrite: true });
      console.log(`   ✔ Moved installer to: release/${platformConfig.id}/${found.name}`);
    } catch (err) {
      console.log(err);
    }
  }

  // Aggressive Cleanup: Remove everything in release except the platform folder
  if (await fs.pathExists(releaseDir)) {
    const files = await fs.readdir(releaseDir);
    for (const file of files) {
      const fullPath = path.join(releaseDir, file);
      if (file === platformConfig.id) continue;
      try {
        await fs.remove(fullPath);
      } catch (e) { }
    }
  }

  log("\n4/4", "Complete");
  const finalCheck = findInstaller(finalArtifactDir, ext);

  if (finalCheck) {
    console.log(`${colors.green}   Build Successful!${colors.reset}`);
    console.log(`   Installer: ${finalCheck.path}\n`);
  } else {
    console.log(`${colors.yellow}   Build finished, but no installer found.${colors.reset}\n`);
  }
}

runBuild().catch(err => {
  console.error(`\n${colors.red}[FATAL] ${err.message}${colors.reset}`);
  process.exit(1);
});