'use strict';

var isChannelReady = false;
var isInitiator = false;
// var isStarted = false;
var isFull = false;
var localStream;
var pc = {pcs:[{pc: null, isStarted: false, inProgress: false}]};
var remoteStream;
var turnReady;
var peerNumGlobal = 0;
var roomEmpty = true;
var sendChannel;

var pcConfig = {
  'iceServers': []
};

var bitrateDiv = document.querySelector('div#bitrate');
var fileInput = document.querySelector('input#fileInput');
var downloadAnchor = document.querySelector('a#download');
var sendProgress = document.querySelector('progress#sendProgress');
var statusMessage = document.querySelector('span#status');

var filePathName;
var fileName;
var timestampPrev = 0;
var timestampStart;
var statsInterval = null;

// Set up audio and video regardless of what devices are present.
var sdpConstraints = {
  offerToReceiveAudio: false,
  offerToReceiveVideo: true
};

var room = window.location.pathname.split('/').pop() ? window.location.pathname.split('/').pop() : 'foo';

var socket = io.connect();

if (room !== '') {
  if (typeof roomKey === 'undefined' || !roomKey)
    var roomKey = '';
  var token = {roomName: room, value: roomKey, type: 'broadcast'};
  socket.emit('token', token); //send token
  socket.on('authenticated', function () {
    socket.emit('create', room);
    console.log('Attempted to create room', room);
  })
}

socket.on('created', function(room) {
  console.log('Created room ' + room);
  isInitiator = true;
});

socket.on('full', function(room) {
  console.log('Room ' + room + ' is full!');
  isFull = true;
});

socket.on('broadcasting full', function(room) {
  console.log('Room ' + room + ' already has a broadcasting in place');
  alert('Room ' + room + ' already has a broadcasting in place');
});

socket.on('no broadcaster', function(room) {
  console.log('Room ' + room + ' is empty!');
});

socket.on('join', function (room){
  roomEmpty = false;
  console.log('Another peer made a request to join room ' + room);
  // console.log('This peer is the initiator of room ' + room + '!');
  isChannelReady = true;
});

socket.on('joined', function(room) {
  console.log('joined: ' + room);
  isChannelReady = true;
});

socket.on('log', function(array) {
  console.log.apply(console, array);
});

socket.on('iceServers', function(servers) {
  // limit to 5 ICE servers
  pcConfig.iceServers = servers.slice(0, 4);
  turnReady = true;
});

socket.on('file-name', function(data) {
  console.log('FILE NAME ', data);
  if (data.token !== token)
    console.log('file name request with wrong token!');
  console.log('new file ' + data.fileName);
  fileName = data.fileName;
});

socket.on('remove', function(data) {
  console.log('client left', data.id, data.peers, data.type);
  if (data.peers === 0 || data.peers === undefined) {
    roomEmpty = true;
    //force hangup and refresh if room empty for longer than 5 sec (garbage colect.)
    var t = window.setTimeout(function () {
      clearTimeout(t);
      if (roomEmpty)
        hangup();
    }, 5000);
  }
});

socket.on("unauthorized", function(error, callback) {
  console.log('unauthorized');
});

socket.on("error", function(err) {
  console.log(err);
});

function sendMessage(message) {
  console.log('Client sending message: ', message, room);
  message.room = room;
  socket.emit('message', message);
}

// This client receives a message
socket.on('message', function(message) {
  console.log('Client received message:', message);
  if (message.message === 'got user media') {
    maybeStart(message);
  } else if (message.sessionDescription) {
    if (message.sessionDescription.type === 'offer') {
      if (!isInitiator && !pc.pcs[message.peer].isStarted) {
        maybeStart(message);
      }
      pc.pcs[message.peer].pc.setRemoteDescription(new RTCSessionDescription(message.sessionDescription))
      .then(function() {
        return doAnswer(message.peer);
      });
    } else if (message.sessionDescription.type === 'answer' && pc.pcs[message.peer].isStarted) {
      console.log('Answer from peer num.'+JSON.stringify(message.peer));
      pc.pcs[message.peer].pc.setRemoteDescription(new RTCSessionDescription(message.sessionDescription));
    }
  } else if (message.type === 'candidate' && pc.pcs[message.peer].isStarted) {
    var candidate = new RTCIceCandidate({
      sdpMLineIndex: message.label,
      candidate: message.candidate
    });

    pc.pcs[message.peer].pc.addIceCandidate(candidate).then(
      function() {
        onAddIceCandidateSuccess(pc.pcs[message.peer].pc);
      },
      function(err) {
        onAddIceCandidateError(pc.pcs[message.peer].pc, err);
    });
    console.log(pc.pcs[message.peer].pc + ' ICE candidate: \n' + (candidate ? candidate.candidate : '(null)'));

  } else if (message.message === 'request file'){
    if (filePathName) {
      sendData(filePathName);
    } else {
      if (!fileName)
        fileName = 'demovideo';

      getFileObject('https://localhost:1337/recordings/'+fileName + '.mp4', function (fileObject) {
        console.log(fileObject);
        sendData(fileObject);
      });
    }

  } else if (message.message === 'bye') {
    if (message.peer || message.peer === 0) {
      handleRemoteHangup(message.peer);
    }
  }
});

////////////////////////////////////////////////////

var localVideo = document.querySelector('#localVideo');
var remoteVideo = document.querySelector('#remoteVideo');

navigator.mediaDevices.getUserMedia({
  audio: false,
  video: {
    "min":{"width":"720","height":"360"},
    "max":{"width":"1920","height":"1080"}
  }
})
.then(gotStream)
.catch(function(e) {
  alert('getUserMedia() error: ' + e.name);
});

fileInput.addEventListener('change', handleFileInputChange, false);

function handleFileInputChange() {
  filePathName = fileInput.files[0];
  console.log(filePathName);
  if (!filePathName) {
    console.log('No file chosen');
  } else {
    console.log('file added');
  }
}

// Needed for converting remote url to blob and then to file
var getFileBlob = function (url, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", url);
  xhr.responseType = "blob";
  xhr.addEventListener('load', function() {
    cb(xhr.response);
  });
  xhr.send();
};
var blobToFile = function (blob, name) {
  blob.lastModifiedDate = new Date();
  blob.name = name;
  return blob;
};
var getFileObject = function(filePathOrUrl, cb) {
  getFileBlob(filePathOrUrl, function (blob) {
    try {
      cb(blobToFile(blob, 'https://localhost:1337/recordings/' + fileName + '.mp4'));
    } catch (e) {console.log(e);}
  });
};

function gotStream(stream) {
  console.log('Adding local stream.');
  localStream = stream;
  localVideo.srcObject = stream;
  sendMessage({message:'got user media', peer: -1});
}

console.log('Getting user media with constraints', sdpConstraints);

function maybeStart(message) {
  console.log('>>>>>>> maybeStart() ', localStream, isChannelReady);
  if (!isFull && typeof localStream !== 'undefined' && isChannelReady) {
    // if(!message.peer) message.peer = peerNumGlobal;
    peerNumGlobal = message.peer;
    console.log('>>>>>> creating peer connection ',message.peer,message.room);
    createPeerConnection(message.peer);
    window.localStream.getTracks().forEach(
    function(track) {
      pc.pcs[message.peer].pc.addTrack(
      track,
      window.localStream
      );
    });
    pc.pcs[message.peer].isStarted = true;
    console.log('isInitiator', isInitiator);
    doCall(message.peer);
  }
}

window.onbeforeunload = function() {
  sendMessage({message:'bye'});
};

/////////////////////////////////////////////////////////

function createPeerConnection(peerNum) {
  function onIceSuccess(peerNum) {
    try {
      if (!pc.pcs[peerNum]) {
        console.log('>>creating pc object', peerNum);
        pc.pcs.push({pc: null, isStarted: false, inProgress: false});
      } else if (pc.pcs[peerNum] === null) {
          pc.pcs[peerNum] = {pc: null, isStarted: false, inProgress: false};
      }
      pc.pcs[peerNum].pc = new RTCPeerConnection(pcConfig);

      sendChannel = pc.pcs[peerNum].pc.createDataChannel('sendDataChannel');
      sendChannel.binaryType = 'arraybuffer';
      sendChannel.onopen = onSendChannelStateChange;
      sendChannel.onclose = onSendChannelStateChange;
      // fileInput.disabled = true;

      pc.pcs[peerNum].pc.onicecandidate = function(e) {handleIceCandidate(pc.pcs[peerNum].pc, e);};
      pc.pcs[peerNum].pc.ontrack = function(e) {handleRemoteStreamAdded(pc.pcs[peerNum].pc, e);};
      pc.pcs[peerNum].pc.onremovestream = handleRemoteStreamRemoved;
      pc.pcs[peerNum].pc.oniceconnectionstatechange = function(e) {
        onIceStateChange(pc.pcs[peerNum].pc, e);
        if (pc.pcs[peerNum].pc && pc.pcs[peerNum].pc.iceConnectionState === 'connected') {
          console.log('ICE Connected!');
        }
      };
      console.log('Created RTCPeerConnnection');
    } catch (e) {
      console.log('Failed to create PeerConnection, exception: ' + e.message);
      // alert('Cannot create RTCPeerConnection object.');
      // return;
    }
  }

  onIceSuccess(peerNum);
}

function handleIceCandidate(pc, event) {
  console.log('icecandidate event: ', event);
  if (event.candidate) {
    sendMessage({
      type: 'candidate',
      label: event.candidate.sdpMLineIndex,
      id: event.candidate.sdpMid,
      candidate: event.candidate.candidate,
      peer: peerNumGlobal
    });
  } else {
    console.log('End of candidates.');
  }
}

function handleCreateOfferError(event) {
  console.log('createOffer() error: ', event);
}

function doCall(peerNum) {
  console.log('Sending offer to peer number ' + peerNum);
  pc.pcs[peerNum].pc.createOffer(sdpConstraints).then(setLocalAndSendMessage, handleCreateOfferError);
}

function doAnswer(peerNum) {
  console.log('Sending answer to peer number ' + peerNum);
  pc.pcs[peerNum].pc.createAnswer().then(
  setLocalAndSendMessage,
  onCreateSessionDescriptionError
  );
}

function setLocalAndSendMessage(sessionDescription) {

  sessionDescription.sdp = preferH264(sessionDescription.sdp);
  pc.pcs[peerNumGlobal].pc.setLocalDescription(sessionDescription);
  console.log('setLocalAndSendMessage sending message', sessionDescription);
  sendMessage({ sessionDescription: sessionDescription, peer: peerNumGlobal });
}

function onCreateSessionDescriptionError(error) {
  console.log('Failed to create session description: ' + error.toString());
}

function handleRemoteStreamAdded(pc, event) {
  remoteStream = event.streams[0];
  remoteVideo.srcObject = remoteStream;
  console.log('Remote stream added.');
}

function handleRemoteStreamRemoved(event) {
  console.log('Remote stream removed. Event: ', event);
}

function onIceStateChange(pc, event) {
  if (pc) {
    console.log(pc + ' ICE state: ' + pc.iceConnectionState);
    console.log('ICE state change event: ', event);
    // TODO: get rid of this in favor of http://w3c.github.io/webrtc-pc/#widl-RTCIceTransport-onselectedcandidatepairchange
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      console.log('ICE change completed!');
      console.log(pc);
      try {
        if (!window.pc.pcs[peerNumGlobal].inProgress) {
          window.pc.pcs[peerNumGlobal].inProgress = true;
          peerNumGlobal++;
        }
      } catch (e) {console.log(e);}
      console.log(peerNumGlobal);
    } else if (pc.iceConnectionState === 'failed') {
      //force hangup and refresh of all
      hangup();
    }
  }
}

function hangup() {
  console.log('Hanging up!');
  sendMessage({message: 'bye'});
  stopAll();
  location.reload();
}

function handleRemoteHangup(peer) {
  console.log('Session terminated.');
  if (peer || peer === 0) stop(peer);
  isInitiator = false;
}

function stop(peer) {
  pc.pcs[peer].isStarted = false;
  pc.pcs[peer].inProgress = false;
  isFull=false;
  if (pc.pcs[peer].pc) {
    pc.pcs[peer].pc.close();
    pc.pcs[peer].pc = null;
  }
  console.log('Peer connection ' + peer + ' cleared.');
  peerNumGlobal=peer;
}

function stopAll() {
  // isStarted = false;
  isFull=false;
  pc.pcs.forEach(function (peercon) {
    try {
      peercon.pc.close();
    } catch (e) {console.log(e);}
    peercon.pc = null;
    peercon.isStarted = false;
    peercon.inProgress = false;
  });
  peerNumGlobal=0;
}

///////////////////////////////////////////

function sendData(file) {
  // Handle 0 size files.
  statusMessage.textContent = '';
  downloadAnchor.textContent = '';
  if (file.size === 0) {
    bitrateDiv.innerHTML = '';
    statusMessage.textContent = 'File is empty, please select a non-empty file';
    closeDataChannels();
    return;
  }
  // console.log('File is ' + [file.name, file.size, file.type,
  //   file.lastModifiedDate
  // ].join(' '));
  sendMessage({message:'send file', fileName: file.name, fileSize: file.size});
  sendProgress.max = file.size;
  var chunkSize = 16384;
  var sliceFile = function(offset) {
    var reader = new window.FileReader();
    reader.onload = (function() {
      return function(e) {
        sendChannel.send(e.target.result);
        if (file.size > offset + e.target.result.byteLength) {
          window.setTimeout(sliceFile, 0, offset + chunkSize);
        }
        sendProgress.value = offset + e.target.result.byteLength;
      };
    })(file);
    var slice = file.slice(offset, offset + chunkSize);
    reader.readAsArrayBuffer(slice);
  };
  sliceFile(0);
}

function closeDataChannels() {
  console.log('Closing data channels');
  sendChannel.close();
  // re-enable the file select
  fileInput.disabled = false;
}

function onSendChannelStateChange() {
  var readyState = sendChannel.readyState;
  console.log('-------------->Send channel state is: ' + readyState);
  if (readyState === 'open') {
    // sendData();
  }
}

function onReceiveChannelStateChange() {
  var readyState = receiveChannel.readyState;
  console.log('Receive channel state is: ' + readyState);
  if (readyState === 'open') {
    timestampStart = (new Date()).getTime();
    timestampPrev = timestampStart;
    statsInterval = window.setInterval(displayStats, 500);
    window.setTimeout(displayStats, 100);
    window.setTimeout(displayStats, 300);
  }
}

function extractSdp(sdpLine, pattern) {
  var result = sdpLine.match(pattern);
  return result && result.length === 2 ? result[1] : null;
}

// Set the selected codec to the first in m line.
function setDefaultCodec(mLine, payload) {
  var elements = mLine.split(' ');
  var newLine = [];
  var index = 0;
  for (var i = 0; i < elements.length; i++) {
    if (index === 3) { // Format of media starts from the fourth.
      newLine[index++] = payload; // Put target payload to the first.
    }
    if (elements[i] !== payload) {
      newLine[index++] = elements[i];
    }
  }
  return newLine.join(' ');
}

// Set H.264 as the default video codec if it's present.
function preferH264(sdp) {
  var sdpLines = sdp.split('\r\n');
  var mLineIndex;
  // Search for m line.
  for (var i = 0; i < sdpLines.length; i++) {
    if (sdpLines[i].search('m=video') !== -1) {
      mLineIndex = i;
      break;
    }
  }
  if (mLineIndex === null) {
    return sdp;
  }

  // If h264 is available, set it as the default in m line.
  for (i = 0; i < sdpLines.length; i++) {
    if (sdpLines[i].search('H264/90000') !== -1) {
      var h264Payload = extractSdp(sdpLines[i], /:(\d+) h264\/90000/i);
      if (h264Payload) {
        sdpLines[mLineIndex] = setDefaultCodec(sdpLines[mLineIndex],
        h264Payload);
      }
      break;
    }
  }
  // Remove CN in m line and sdp.
  sdpLines = removeCN(sdpLines, mLineIndex);
  sdp = sdpLines.join('\r\n');
  return sdp;
}

// Strip CN from sdp before CN constraints is ready.
function removeCN(sdpLines, mLineIndex) {
  var mLineElements = sdpLines[mLineIndex].split(' ');
  // Scan from end for the convenience of removing an item.
  for (var i = sdpLines.length - 1; i >= 0; i--) {
    var payload = extractSdp(sdpLines[i], /a=rtpmap:(\d+) CN\/\d+/i);
    if (payload) {
      var cnPos = mLineElements.indexOf(payload);
      if (cnPos !== -1) {
        // Remove CN payload from m line.
        mLineElements.splice(cnPos, 1);
      }
      // Remove CN line in sdp
      sdpLines.splice(i, 1);
    }
  }

  sdpLines[mLineIndex] = mLineElements.join(' ');
  return sdpLines;
}

function onAddIceCandidateSuccess(pc) {
  console.log(pc + ' addIceCandidate success');
}

function onAddIceCandidateError(pc, error) {
  console.log(pc + ' failed to add ICE Candidate: ' + error.toString());
}