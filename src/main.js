import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  dialog,
  session,
} from 'electron';
import path from 'path';
import { config } from './config/index.js';
import { fileURLToPath } from 'url';
import electronContextMenu from 'electron-context-menu';

// Constants
const APP_URL = 'https://chat.deepseek.com';
const DEEPSEEK_PROTOCOL = 'deepseek://';
const ICON_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../assets/icon.png'
);

// Set default fallback user agent to standard browser UA
app.userAgentFallback = config.userAgent;

// Set up the context menu with navigation controls
electronContextMenu({
  showSaveImageAs: true,
  append: (defaultActions, parameters, browserWindow) => [
    {
      label: 'Back',
      visible: Boolean(browserWindow?.webContents?.canGoBack?.()),
      click: () => browserWindow?.webContents?.goBack?.(),
    },
    {
      label: 'Forward',
      visible: Boolean(browserWindow?.webContents?.canGoForward?.()),
      click: () => browserWindow?.webContents?.goForward?.(),
    },
    {
      label: 'Reload',
      click: () => browserWindow?.webContents?.reload?.(),
    },
    {
      label: 'Home (DeepSeek)',
      click: () =>
        browserWindow?.loadURL?.(APP_URL, { userAgent: config.userAgent }),
    },
  ],
});

let mainWindow = null;
let tray = null;
let isQuitting = false;

/**
 * Shows an informative dialog explaining Google's OAuth policy on desktop webviews
 * and guides the user on how to sign in.
 * @param {BrowserWindow} targetWindow - The window to attach the dialog to.
 */
function showGoogleSignInNotice(targetWindow) {
  dialog
    .showMessageBox(targetWindow, {
      type: 'info',
      title: 'Google Sign-In Restricted',
      message: 'Google Sign-In is blocked in embedded desktop applications.',
      detail:
        'Google restricts OAuth logins inside desktop webviews due to security policies (RFC 8252).\n\n' +
        'How to log in to your account:\n' +
        '1. Use your Email and Password on the login screen.\n' +
        '2. If you originally registered using "Continue with Google", click "Forgot password?" on DeepSeek to set a password for your Gmail address.\n\n' +
        'Once set, you can log in directly using your email and password.',
      buttons: ['OK', 'Open DeepSeek in Browser'],
      defaultId: 0,
      cancelId: 0,
    })
    .then(({ response }) => {
      if (response === 1) {
        shell.openExternal(APP_URL);
      }
    })
    .catch(console.error);
}

/**
 * Handles new window creation requests.
 * @param {Object} details - Details about the new window.
 * @returns {Object} Action to take.
 */
function handleNewWindow(details) {
  if (
    details.url.includes('accounts.google.com') ||
    details.url.includes('/oauth/google/authorize')
  ) {
    if (mainWindow) {
      showGoogleSignInNotice(mainWindow);
    }
    return { action: 'deny' };
  }

  // Open external links (such as policy docs, external sites) in the default system browser
  if (
    !details.url.startsWith(APP_URL) &&
    (details.url.startsWith('https://') || details.url.startsWith('http://'))
  ) {
    shell.openExternal(details.url);
    return { action: 'deny' };
  }

  return { action: 'allow' };
}

/**
 * Creates the main application window.
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'preload.js'
      ),
      webSecurity: true,
    },
  });

  mainWindow.loadURL(APP_URL, {
    userAgent: config.userAgent,
  });

  mainWindow.webContents.setWindowOpenHandler(handleNewWindow);

  // Intercept in-page navigation to Google OAuth to prevent getting stuck on Google's error page
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (
      url.includes('accounts.google.com') ||
      url.includes('/oauth/google/authorize')
    ) {
      event.preventDefault();
      showGoogleSignInNotice(mainWindow);
    }
  });

  // Keyboard navigation shortcuts
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    // Alt + Left: Navigate Back
    if (input.alt && input.key === 'ArrowLeft') {
      if (mainWindow.webContents.canGoBack()) {
        event.preventDefault();
        mainWindow.webContents.goBack();
      }
    }

    // Alt + Right: Navigate Forward
    if (input.alt && input.key === 'ArrowRight') {
      if (mainWindow.webContents.canGoForward()) {
        event.preventDefault();
        mainWindow.webContents.goForward();
      }
    }

    // Ctrl + R or F5: Reload
    if (
      (input.control && input.key.toLowerCase() === 'r') ||
      input.key === 'F5'
    ) {
      event.preventDefault();
      mainWindow.webContents.reload();
    }

    // Ctrl + H: Go to DeepSeek Home
    if (input.control && input.key.toLowerCase() === 'h') {
      event.preventDefault();
      mainWindow.loadURL(APP_URL, { userAgent: config.userAgent });
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
  });

  // Intercept the close (X) button to hide the window instead of quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

/**
 * Creates the system tray icon and context menu.
 */
function createTray() {
  const icon = nativeImage
    .createFromPath(ICON_PATH)
    .resize({ width: 24, height: 24 });

  tray = new Tray(icon);
  tray.setToolTip('DeepSeek');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open DeepSeek',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Toggle/show window on tray icon click
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/**
 * Processes command line arguments to extract a valid URL.
 * @param {Array<string>} args - Command line arguments.
 * @returns {string|null} The extracted URL or null.
 */
function processCommandLineArgs(args) {
  const httpsRegex = /^https:\/\/chat\.deepseek\.com(?:[/?#].*)?$/;
  const deepseekRegex = /^deepseek:\/\//;

  for (const arg of args) {
    if (httpsRegex.test(arg)) {
      return arg;
    }
    if (deepseekRegex.test(arg)) {
      const deepseekPath = arg
        .substring(DEEPSEEK_PROTOCOL.length)
        .replace(/^\/+/, '');
      return `${APP_URL}/${deepseekPath}`;
    }
  }
  return null;
}

/**
 * Handles second instance events.
 * @param {Event} event - The event.
 * @param {Array<string>} args - Command line arguments.
 */
function handleSecondInstance(event, args) {
  if (mainWindow) {
    const url = processCommandLineArgs(args);
    if (url) {
      mainWindow.loadURL(url, { userAgent: config.userAgent });
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
  }
}

/**
 * Initializes the application.
 */
async function initializeApp() {
  // Set the app name
  app.setName('DeepSeek');

  // Request single instance lock
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  // Set isQuitting flag before quitting so window.close handler allows termination
  app.on('before-quit', () => {
    isQuitting = true;
  });

  // Wait for app to be ready
  await app.whenReady();

  // Set default session User-Agent to match configured browser UA
  session.defaultSession.setUserAgent(config.userAgent);

  // Create the main window and system tray icon
  createMainWindow();
  createTray();

  // Handle second instance
  app.on('second-instance', handleSecondInstance);

  // Keep app running in the background/tray when all windows are closed/hidden
  app.on('window-all-closed', () => {
    if (isQuitting) {
      app.quit();
    }
  });

  // Handle activate (macOS)
  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createMainWindow();
    }
  });
}

// Start the application
initializeApp().catch(console.error);
