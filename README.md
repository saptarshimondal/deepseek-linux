# DeepSeek Desktop

<p align="center">
  <img src="./assets/icon.png" alt="DeepSeek Desktop" width="128" height="128" />
</p>

DeepSeek Desktop is an unofficial, lightweight desktop application for DeepSeek AI, providing a seamless and responsive desktop experience on Linux distributions.

---

## 🛠 **Features**

- **DeepSeek Chat**: Fast and direct access to [chat.deepseek.com](https://chat.deepseek.com) inside a dedicated desktop window.
- **System Tray Integration**: Runs unobtrusively in the background with an icon in the system tray / notification area.
- **Close to Tray**: Clicking the window's close (`X`) button hides the application to the background rather than terminating your session.
- **Start Menu & Desktop Integration**: Full integration with Linux desktop environments (Linux Mint Cinnamon, MATE, GNOME, XFCE, KDE) with standard high-resolution icons.
- **Single Instance**: Running `deepseek-linux` or opening a link restores and focuses the active window.
- **Secure**: Direct HTTPS communication with DeepSeek, keeping your credentials and conversations private.
- **Open Source**: Built with Electron.

---

## 📦 **Installation**

Pre-built binaries for **`.deb`** and **`.snap`** are available on the [GitHub Releases](https://github.com/evildevill/deepseek-linux/releases) page.

### Option 1: Install DEB Package (Debian, Ubuntu, Linux Mint, etc.)

1. Download the latest `.deb` package from [Releases](https://github.com/evildevill/deepseek-linux/releases).
2. Install via terminal:
   ```bash
   sudo dpkg -i deepseek-linux_*_amd64.deb
   sudo apt-get install -f # Fix any missing dependencies if needed
   ```
   _Or install using `apt`:_
   ```bash
   sudo apt install ./deepseek-linux_*_amd64.deb
   ```

### Option 2: Install SNAP Package

1. Download the latest `.snap` package from [Releases](https://github.com/evildevill/deepseek-linux/releases).
2. Install via terminal:
   ```bash
   sudo snap install --dangerous ./deepseek-linux_*_amd64.snap
   ```

---

## 🔨 **Build From Source**

### Prerequisites

- Node.js (LTS recommended, v20+)
- npm

### Steps

1. **Clone the repository**:

   ```bash
   git clone https://github.com/evildevill/deepseek-linux.git
   cd deepseek-linux
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Start in development mode**:

   ```bash
   npm start
   ```

4. **Build release packages**:

   ```bash
   # Build DEB package only
   npm run dist:deb

   # Build SNAP package only
   npm run dist:snap

   # Build both DEB and SNAP packages
   npm run dist:all
   ```

   The compiled packages will be placed in the `dist/` directory:
   - `dist/deepseek-linux_*_amd64.deb`
   - `dist/deepseek-linux_*_amd64.snap`

---

## ↩️ **Uninstallation**

### For DEB Package

```bash
sudo apt remove deepseek-linux
```

### For SNAP Package

```bash
sudo snap remove deepseek-linux
```

---

## 📖 **Usage Instructions**

### Launching the Application

- Launch from your desktop's application / start menu (search for **DeepSeek**).
- Or run in terminal:
  ```bash
  deepseek-linux
  ```

### System Tray & Background Controls

- **Hide Window**: Click the window's close (`X`) button to hide the window to the system tray while keeping the app active in the background.
- **Restore Window**: Click the DeepSeek tray icon or select **Open DeepSeek** from the tray menu.
- **Exit Completely**: Right-click the DeepSeek tray icon and select **Exit**.

---

## 🤝 **Contributing**

Contributions are welcome! If you'd like to contribute to this project, please fork the repository and submit a pull request.

---

## 📜 **License**

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.

---

## Acknowledgments

- **DeepSeek** - [chat.deepseek.com](https://chat.deepseek.com)
- **Electron** - Cross-platform desktop application framework.
