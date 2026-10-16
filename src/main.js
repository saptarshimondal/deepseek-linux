import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron';
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

// Set up the context menu
electronContextMenu({
  showSaveImageAs: true,
});

let mainWindow = null;
let tray = null;
let isQuitting = false;

/**
 * Handles new window creation, specifically for Google Sign-In popups.
 * @param {Object} details - Details about the new window.
 * @returns {Object} Action to take.
 */
function handleNewWindow(details) {
  if (details.url.includes('accounts.google.com')) {
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
      nativeWindowOpen: true,
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
