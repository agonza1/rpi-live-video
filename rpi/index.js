const express = require('express');
const child_process = require('child_process');
const cors = require('cors');
const util = require('util');
const serveIndex = require('serve-index');
const io = require('socket.io-client');
const signaling_backend = process.env.SIGNALING_SERVER || 'agonza1.tk';
var socket = io.connect('https://' + signaling_backend);
const exec = util.promisify(child_process.exec);

const app = express();

const room_name = process.env.ROOM_NAME || 'agonza1';

app.use(cors());
app.use(express.static('public'));
app.use('/', serveIndex('public'));

async function off_camera_driver() {
  const { stdout, stderr } = await exec("kill $(lsof /dev/video0  | awk '{print $2}')");
  console.log('stdout:', stdout);
  console.log('stderr:', stderr);
}

class Call {
  constructor(id, room, status, process) {
    this.id = id;
    this.room = room;
    this.status = status;
    this.process = process;
    this.changeStatus = function (status) {
      this.status = status;
    }
  }

  getCallProcess(){
    if (!this.process)
      return false;
    return this.process;
  }

  startCall(token) {
    var that = this;
    console.log('Token: ' + token);
    console.log('Room: ' + this.room );
    that.changeStatus('started');
    var args = [
      // '--allow-running-insecure-content',
      // '--ignore-urlfetcher-cert-requests',
      '--allow-insecure-localhost',
      '--disable-gpu',
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      'https://'+ signaling_backend +'/secure_broadcast/'+ that.room + '?token=' + token
    ];
    var env = Object.assign({}, process.env);
    var chrome = child_process.spawn('chromium-browser', args, {
      env: env
    });
    this.process = chrome;
    chrome.stdout.on('data', function(data) {
      console.log('Chrome.Out: ' + data);
    });

    chrome.stderr.on('data', function(data) {
      console.log('Chrome.Err: ' + data);
    });

  }

  endCall(process) {
    console.log('kill process');
    process.stdin.pause();
    process.kill();
    this.changeStatus('ended');
  }
}

var deviceId = process.env.DEVICE_ID || 'rpi-test';
var myCall = new Call(deviceId, room_name, 'generated');
myCall.startCall();
console.log('Connecting to', signaling_backend);

socket.on('connect', function(){
  console.log('RPI Connected');
  socket.emit('rpi-connect', deviceId, room_name, (res, err) => {
    if (err || !res)
      throw Error('Error Connecting', err);
    console.log(deviceId + ' connection success!');
  });
  socket.on('webrtc-streaming-action', function(message){
    handleServerMessage(message);
  });
});

socket.on('disconnect', function(){
  console.log('RPI disconnected');
});

function handleServerMessage(msg) {
  console.log('Signaling Server Message: ',msg);
}
