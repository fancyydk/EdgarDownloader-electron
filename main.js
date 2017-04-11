const request = require('request');
const fs = require('fs');
const jetpack = require('fs-jetpack');
const electron = require('electron')
// Module to control application life.
const app = electron.app
const ipcMain = electron.ipcMain;
const dialog = electron.dialog;
const shell = electron.shell;
// Module to create native browser window.
const BrowserWindow = electron.BrowserWindow

const path = require('path');
const url = require('url');
const downloadRequestTimeout = 250; // 250 milliseconds = 0.25 seconds

let formTypes = [
  '10-K'
];

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

function createWindow () {
  // Create the browser window.
  mainWindow = new BrowserWindow({width: 1200, height: 800});

  // and load the index.html of the app.
  mainWindow.loadURL(url.format({
    pathname: path.join(__dirname, 'index.html'),
    protocol: 'file:',
    slashes: true
  }));

  // Open the DevTools.
  // mainWindow.webContents.openDevTools()

  // Emitted when the window is closed.
  mainWindow.on('closed', function () {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed.
app.on('window-all-closed', function () {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function () {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
ipcMain.on('choose-dir', (event, arg) => {
  if (arg === 'downloads') {
    event.returnValue = app.getPath('downloads');
  } else {
    dialog.showOpenDialog({properties: ['openDirectory']}, (filePaths) => {
      if (filePaths && filePaths[0]) {
        event.returnValue = filePaths[0];
      } else {
        event.returnValue = '';
      }
    });
  }
});

ipcMain.on('open-dir', (event, arg) => {
  shell.openItem(arg);
});

let unlinkFileAndRemoveDir = function (event, dirPath, filePath) {
  fs.unlink(filePath, (err) => {
    if (err && err.code === 'ENOENT') {
      event.sender.send('status-report', 'Error: file does not exist and cannot be deleted. (' + err.code + ')');
    } else if (err) {
      event.sender.send('status-report', 'Error: an error occurred. (' + err.code + ')');
    } else {
      jetpack.removeAsync(dirPath);
    }
  });
}

let iterateOverUrlArray = function (saveDirectory, indexSrc, callback) {
  let promises = [];
  let indexSrcInfo = JSON.parse(indexSrc);
  let urlInfoArray = indexSrcInfo.urls;
  urlInfoArray.forEach((urlInfo) => {
    let year = urlInfo.year;
    let quarter = urlInfo.quarter;
    let parsed = url.parse(urlInfo.url);
    let dirPath = path.join(saveDirectory, year, 'QTR' + quarter);
    promises.push(callback(indexSrcInfo.edgarUrl, urlInfo, year, quarter, parsed, dirPath));
  });
  return promises;
};

let downloadFile = function (event, url, dirPath, filePath) {
  jetpack.dirAsync(dirPath).then(() => {
    try {
      let file = fs.createWriteStream(filePath);
      let sendReq = request.get(url);

      sendReq
        .on('response', function (response) {
          // verify response code
          if (response.statusCode !== 200) {
            event.sender.send('download-failure');
            event.sender.send('status-report', 'Error: failed to download ' + url + ' to ' + filePath + '. response status was ' + response.statusCode);
            unlinkFileAndRemoveDir(event, dirPath, filePath);
          }
        })
        .on('error', function (err) {
          // check for request errors
          event.sender.send('download-failure');
          event.sender.send('status-report', 'Error: failed to download ' + url + ' to ' + filePath + '. ' + err.message);
          unlinkFileAndRemoveDir(event, dirPath, filePath);
          return;
        })
        .pipe(file);

      file
        .on('finish', function() {
          try {
            file.close(() => {
              event.sender.send('download-success');
              event.sender.send('status-report', 'saved to ' + filePath);
            });  // close() is async, call cb after close completes.
          } catch (exception) {
            event.sender.send('download-failure');
            event.sender.send('status-report', 'Error: failed to download ' + url + ' to ' + filePath + '. ' + exception.message);
            unlinkFileAndRemoveDir(event, dirPath, filePath);
          }
        })
        .on('error', function(err) { // Handle errors
          event.sender.send('download-failure');
          event.sender.send('status-report', 'Error: failed to download ' + url + ' to ' + filePath + '. ' + err.message);
          unlinkFileAndRemoveDir(event, dirPath, filePath);
          return;
        });
    } catch (exception) {
      event.sender.send('download-failure');
      event.sender.send('status-report', 'Error: failed to download ' + url + ' to ' + filePath + '. ' + exception.message);
      unlinkFileAndRemoveDir(event, dirPath, filePath);
      return;
    }
  });
};

ipcMain.on('download-forms', (event, saveDirectory, indexSrc) => {
  let requestTimeout = 0;
  iterateOverUrlArray(saveDirectory, indexSrc, (edgarUrl, urlInfo, year, quarter, parsed, dirPath) => {
    let fileName = 'forms.json';
    let filePath = path.join(dirPath, fileName);
    jetpack.readAsync(filePath).then((data) => {
      let forms = JSON.parse(data);
      forms.forEach((form) => {
        let formDir = path.join(dirPath, form.CIK);
        let formFilePath = path.join(formDir, path.basename(form.url));
        setTimeout(() => {
          downloadFile(event, edgarUrl + form.url, formDir, formFilePath);
        }, requestTimeout);
        requestTimeout += downloadRequestTimeout;
      });
    });
  });  
});

ipcMain.on('extract-index', (event, saveDirectory, indexSrc) => {
  let totalFormsToDownload = 0;
  let promises = iterateOverUrlArray(saveDirectory, indexSrc, (edgarUrl, urlInfo, year, quarter, parsed, dirPath) => {
    let promise = new Promise((resolve, reject) => {
      let forms = [];
      let fileName = 'forms.json';
      let filePath = path.join(dirPath, fileName);
      let indexPath = path.join(dirPath, 'company.idx');
      jetpack.readAsync(indexPath).then((data) => {
        let lines = data.split('\n');
        lines.forEach((line) => {
          let formType = line.substring(62, 74).trim();
          let CIK = line.substring(74, 86).trim();
          let url = line.substring(98).trim();
          if (formTypes.includes(formType)) {
            forms.push({ formType: formType, CIK: CIK, url: url });
          }
        });

        if (forms.length > 0) {
          totalFormsToDownload += forms.length;
          jetpack.writeAsync(filePath, forms).then(() => {
            event.sender.send('status-report', 'saved to ' + filePath);
            resolve();
          });
        } else {
          event.sender.send('status-report', 'No forms in ' + year + '/QTR' + quarter);
          resolve();
        }
      });
    });
    return promise;
  });

  Promise.all(promises).then(() => {
    mainWindow.webContents.send('num-forms', totalFormsToDownload);
  });
});

ipcMain.on('download-index', (event, saveDirectory, indexSrc) => {
  let requestTimeout = 0;
  iterateOverUrlArray(saveDirectory, indexSrc, (edgarUrl, urlInfo, year, quarter, parsed, dirPath) => {
    let fileName = path.basename(parsed.pathname);
    let filePath = path.join(dirPath, fileName);
    setTimeout(() => {
      event.sender.send('status-report', 'started downloading ' + urlInfo.url);
      downloadFile(event, urlInfo.url, dirPath, filePath);
    }, requestTimeout);
    requestTimeout += downloadRequestTimeout;
  });
});