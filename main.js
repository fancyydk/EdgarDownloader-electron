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

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

function createWindow () {
  // Create the browser window.
  mainWindow = new BrowserWindow({width: 1000, height: 700});

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
      }
    });
  }
});

ipcMain.on('open-dir', (event, arg) => {
  shell.openItem(arg);
});

var iterateOverUrlArray = function (saveDirectory, indexSrc, callback) {
  var indexSrcInfo = JSON.parse(indexSrc);
  var urlInfoArray = indexSrcInfo.urls;
  urlInfoArray.forEach((urlInfo) => {
    var year = urlInfo.year;
    var quarter = urlInfo.quarter;
    var parsed = url.parse(urlInfo.url);
    var dirPath = path.join(saveDirectory, year, 'QTR' + quarter);
    jetpack.dir(dirPath);
    callback(indexSrcInfo.edgarUrl, urlInfo, year, quarter, parsed, dirPath);
  });
};

var downloadFile = function (event, url, filePath) {
  try {
    var file = fs.createWriteStream(filePath);
    var sendReq = request.get(url);

    sendReq
      .on('response', function (response) {
        // verify response code
        if (response.statusCode !== 200) {
          event.sender.send('status-report', 'Error: response status was ' + response.statusCode);
          fs.unlink(filePath, (err) => {
            event.sender.send('status-report', 'Error: ' + err.message);
          });
        }
      })
      .on('error', function (err) {
        // check for request errors
        event.sender.send('status-report', 'Error: ' + err.message);
        fs.unlink(filePath, (err) => {
          event.sender.send('status-report', 'Error: ' + err.message);
        });
        return;
      })
      .pipe(file);

    file.on('finish', function() {
      try {
        file.close(() => {
          event.sender.send('status-report', 'saved to ' + filePath);
        });  // close() is async, call cb after close completes.
      } catch (exception) {
        event.sender.send('status-report', 'Error: ' + exception.message);
      }
    });

    file.on('error', function(err) { // Handle errors
      event.sender.send('status-report', 'Error: ' + err.message);
      fs.unlink(filePath, (err) => {
        event.sender.send('status-report', 'Error: ' + err.message);
      }); // Delete the file async. (But we don't check the result)
      return;
    });
  } catch (exception) {
    event.sender.send('status-report', 'Error: ' + exception.message);
    return;
  }
};

ipcMain.on('download-10k', (event, saveDirectory, indexSrc) => {
  iterateOverUrlArray(saveDirectory, indexSrc, (edgarUrl, urlInfo, year, quarter, parsed, dirPath) => {
    var fileName = '10K.json';
    var filePath = path.join(dirPath, fileName);
    jetpack.readAsync(filePath).then((data) => {
      var tenKs = JSON.parse(data);
      tenKs.forEach((tenK) => {
        var tenKDir = path.join(dirPath, tenK.CIK);
        var tenKFilePath = path.join(tenKDir, path.basename(tenK.url));
        jetpack.dir(tenKDir);
        downloadFile(event, edgarUrl + tenK.url, tenKFilePath);
      });
    });
  });  
});

ipcMain.on('extract-index', (event, saveDirectory, indexSrc) => {
  iterateOverUrlArray(saveDirectory, indexSrc, (edgarUrl, urlInfo, year, quarter, parsed, dirPath) => {
    var tenKs = [];
    var fileName = '10K.json';
    var filePath = path.join(dirPath, fileName);
    var indexPath = path.join(dirPath, 'company.idx');
    jetpack.readAsync(indexPath).then((data) => {
      var lines = data.split('\n');
      lines.forEach((line) => {
        var formType = line.substring(62, 74).trim();
        var CIK = line.substring(74, 86).trim();
        var url = line.substring(98).trim();
        if (formType === '10-K') {
          tenKs.push({ formType: formType, CIK: CIK, url: url });
        }
      });

      if (tenKs.length > 0) {
        jetpack.writeAsync(filePath, tenKs).then(() => {
          event.sender.send('status-report', 'saved to ' + filePath);
        });
      } else {
        event.sender.send('status-report', 'No 10-K in ' + year + '/QTR' + quarter);
      }
    });
  });
});

ipcMain.on('download-index', (event, saveDirectory, indexSrc) => {
  iterateOverUrlArray(saveDirectory, indexSrc, (edgarUrl, urlInfo, year, quarter, parsed, dirPath) => {
    var fileName = path.basename(parsed.pathname);
    var filePath = path.join(dirPath, fileName);
    downloadFile(event, urlInfo.url, filePath);
  });
});