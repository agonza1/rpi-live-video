'use strict';

var isChannelReady = false;
var isInitiator = false;
var isStarted = false;
var turnReady = false;
var localStream;
var pc;
var remoteStream;
var peerNumber;
var peerSocketId;
var ICEreceived;
var fileDataReceived;
var receiveChannel;

var bitrateDiv = document.querySelector('div#bitrate');
var downloadAnchor = document.querySelector('a#download');
var receiveProgress = document.querySelector('progress#receiveProgress');

var receiveBuffer = [];
var receivedSize = 0;
var pcConfig = {
  'iceServers': []
};

var bytesPrev = 0;
var timestampPrev = 0;
var timestampStart;
var statsInterval = null;
var bitrateMax = 0;

// Set up audio and video regardless of what devices are present.
var sdpConstraints = {
  offerToReceiveAudio: false,
  offerToReceiveVideo: true
};

var room = window.location.pathname.split('/').pop() ? window.location.pathname.split('/').pop() : 'foo';

var remoteVideo = document.querySelector('#remoteVideo');
// Hacks for Mobile Safari
remoteVideo.setAttribute("playsinline", true);
remoteVideo.setAttribute("controls", true);
setTimeout(() => {
  remoteVideo.removeAttribute("controls");
});

var socket = io.connect();

if (room !== '') {
  if (typeof roomKey === 'undefined' || !roomKey)
    var roomKey = '';
  var token = {roomName: room, value: roomKey, type: 'display'};
  socket.emit('token', token); //send token
  socket.on('authenticated', function () {
    socket.emit('join', room);
    console.log('Attempted to join room', room);
  })
}

socket.on('full', function(room) {
  console.log('Room ' + room + ' is full!');
  alert('Room ' + room + ' is full')
});

socket.on('no broadcaster', function(room) {
  console.log('Room ' + room + ' is empty!');
  // alert('Room ' + room + ' is empty')
  $('.toast-message').attr('value', 'Room ' + room + ' is empty');
  $('.toast-message').fadeIn(400).delay(5000).fadeOut(400); //fade out after 5 seconds
});

socket.on('join', function (room){
  console.log('Another peer made a request to join room ' + room);
  // console.log('This peer is the initiator of room ' + room + '!');
  isChannelReady = true;
  $('.toast-message').attr('value', 'New viewer connected!');
  $('.toast-message').fadeIn(400).delay(4000).fadeOut(400); //fade out after 4 seconds
});

socket.on('joined', function(room, id, num) {
  console.log('joined: ' + room);
  peerSocketId = id;
  peerNumber = num-1;
  isChannelReady = true;
  // for triggering sending media we need this...
  sendMessage({message: 'got user media', peer: peerNumber});
  if (isInitiator) {
    maybeStart_nomedia();
  }
  $('.toast-message').attr('value', 'New user! Num. viewers: ' + num);
  $('.toast-message').stop().fadeIn(500).delay(4000).fadeOut(400); //fade out after 4 seconds
  // alert('New user test 2 (Num. users: ' + num);
});

socket.on('log', function(array) {
  console.log.apply(console, array);
});

ICEreceived = new Promise((resolve, reject) => {
  socket.on('iceServers', function(servers) {
    if (!servers)
      reject('Could not receive ICE servers');
    // limit to 5 ICE servers
    pcConfig.iceServers = servers.slice(0, 4);
    turnReady = true;
    resolve(turnReady);
  });
});

fileDataReceived = new Promise((resolve, reject) => {
  socket.on('message', function(message) {
    if (message.message === 'send file') {
      var file = { size : message.fileSize , name: message.fileName};
      if (!file.size)
        reject('Could not receive file data');
      resolve(file);
    }
  })
});

socket.on("unauthorized", function(error, callback) {
  console.log('unauthorized');
  $('.toast-message').attr('value', 'unauthorized');
  $('.toast-message').stop().fadeIn(500).delay(5000).fadeOut(400); //fade out after 5 seconds
});

socket.on("error", function(err) {
  console.log(err);
  $('.toast-message').attr('value', err);
  $('.toast-message').stop().fadeIn(500).delay(5000).fadeOut(400); //fade out after 5 seconds
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
    if (message.peer === peerNumber)
      ICEreceived.then(() => {
        maybeStart_nomedia();
      });
    if (message.peer === -1)
      location.reload()
  } else if (message.sessionDescription && message.peer === peerNumber) {
    if (message.sessionDescription.type === 'offer') {
      ICEreceived.then(() => {
        if (!isStarted)
          maybeStart_nomedia();
        pc.setRemoteDescription(message.sessionDescription)
        .then(function () {
          return doAnswer();
        });
      });
    } else if (message.sessionDescription.type === 'answer' && isStarted) {
      pc.setRemoteDescription(new RTCSessionDescription(message.sessionDescription));
    }
  } else if (message.type === 'candidate' && isStarted && message.peer === peerNumber) {
    var candidate = new RTCIceCandidate({
      sdpMLineIndex: message.label,
      candidate: message.candidate
    });
    pc.addIceCandidate(candidate).then(
    function() {
      onAddIceCandidateSuccess(pc);
    },
    function(err) {
      onAddIceCandidateError(pc, err);
    });
    console.log(pc + ' ICE candidate: \n' + (candidate ? candidate.candidate : '(null)'));
  } else if(message.message === 'bye' && isStarted) {
    handleRemoteHangup(message);
  }
});

////////////////////////////////////////////////////

console.log('Getting user media with constraints', sdpConstraints);

function maybeStart_nomedia() {
  console.log('>>>>>>> maybeStart_nomedia() ', isStarted, localStream, isChannelReady);
  if (!isStarted && isChannelReady) {
    console.log('>>>>>> creating peer connection num.' + (peerNumber+1));
    createPeerConnection();
    isStarted = true;
    console.log('isInitiator', isInitiator);
    if (isInitiator) {
      doCall();
    }
  }
}

window.onbeforeunload = function() {
  sendMessage({message: 'bye', peer: peerNumber});
};

function createPeerConnection() {
  function onIceSuccess() {
    try {
      pc = new RTCPeerConnection(pcConfig);
      pc.onicecandidate = function(e) {handleIceCandidate(pc, e);};
      pc.ontrack = handleRemoteStreamAdded;
      pc.onremovestream = handleRemoteStreamRemoved;
      pc.oniceconnectionstatechange = function(e) {
        onIceStateChange(pc, e);
        if (pc && pc.iceConnectionState === 'connected') {
          console.log('ICE Connected!');
        }
      };
      console.log('Created RTCPeerConnnection');
      pc.ondatachannel = receiveChannelCallback;
    } catch (e) {
      console.log('Failed to create PeerConnection, exception: ' + e.message);
      alert('Cannot create RTCPeerConnection object.');
      return;
    }
  }
  onIceSuccess();
}

function handleIceCandidate(pc, event) {
  console.log('icecandidate event: ', event);
  if (event.candidate) {
    sendMessage({
      type: 'candidate',
      label: event.candidate.sdpMLineIndex,
      id: event.candidate.sdpMid,
      candidate: event.candidate.candidate,
      peer: peerNumber
    });
  } else {
    console.log('End of candidates.');
  }
}

function handleCreateOfferError(event) {
  console.log('createOffer() error: ', event);
}

function doCall() {
  console.log('Sending offer to peer');
  pc.createOffer(sdpConstraints).then(setLocalAndSendMessage, handleCreateOfferError);
}

function doAnswer() {
  console.log('Sending answer to peer.');
  pc.createAnswer().then(
  setLocalAndSendMessage,
  onCreateSessionDescriptionError
  );
}

function setLocalAndSendMessage(sessionDescription) {
  sessionDescription.sdp = preferH264(sessionDescription.sdp);
  pc.setLocalDescription(sessionDescription);
  console.log('setLocalAndSendMessage sending message', sessionDescription, peerNumber);
  // sessionDescription.peer = peerNumber;
  sendMessage({ sessionDescription: sessionDescription, peer: peerNumber});
}

function onCreateSessionDescriptionError(error) {
  console.log('Failed to create session description: ' + error.toString());
}

function handleRemoteStreamAdded(event) {
  if (remoteVideo.srcObject !== event.streams[0]) {
    remoteStream = event.streams[0];
    remoteVideo.srcObject = remoteStream;
    console.log('Remote stream added.');
    document.getElementById('spinner').style.display = 'none';
    enableControlButtons();
  }
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
    }
  }
}

function hangup() {
  console.log('Hanging up');
  stop();
  sendMessage({message:'bye', peer: peerNumber});
}

function handleRemoteHangup(msg) {
  if (msg.peer === -1 || msg.peer === peerNumber)
    stop();
  isInitiator = false;
}

function stop() {
  console.log('Session terminated.');
  isStarted = false;
  pc.close();
  pc = null;
}

function closeDataChannels() {
  receiveChannel.close();
  console.log('Closed data channel with label: ' + receiveChannel.label);
}

///////////////////////////////////////////

function receiveChannelCallback(event) {
  console.log('Receive Channel Callback');
  receiveChannel = event.channel;
  receiveChannel.binaryType = 'arraybuffer';
  receiveChannel.onmessage = onReceiveMessageCallback;
  receiveChannel.onopen = onReceiveChannelStateChange;
  receiveChannel.onclose = onReceiveChannelStateChange;

  receivedSize = 0;
  bitrateMax = 0;
  downloadAnchor.textContent = '';
  downloadAnchor.removeAttribute('download');
  if (downloadAnchor.href) {
    URL.revokeObjectURL(downloadAnchor.href);
    downloadAnchor.removeAttribute('href');
  }
}

function onReceiveMessageCallback(event) {
  // console.log('Received Message ' + event.data.byteLength);
  receiveBuffer.push(event.data);
  receivedSize += event.data.byteLength;

  receiveProgress.value = receivedSize;
  // we are assuming that our signaling protocol told
  // about the expected file size (and name, hash, etc).
  // var file = { size : 2265535 , name: 'chrome'};
  fileDataReceived.then((file) => {
    if (receivedSize === file.size) {
      var received = new window.Blob(receiveBuffer);
      receiveBuffer = [];

      downloadAnchor.href = URL.createObjectURL(received);
      downloadAnchor.download = file.name;
      downloadAnchor.textContent =
      'Click to download \'' + file.name.split("/").pop() + '\' (' + file.size + ' bytes)';
      downloadAnchor.style.display = 'block';

      var bitrate = Math.round(receivedSize * 8 /
      ((new Date()).getTime() - timestampStart));
      bitrateDiv.innerHTML = '<strong>Average Bitrate:</strong> ' +
      bitrate + ' kbits/sec (max: ' + bitrateMax + ' kbits/sec)';

      if (statsInterval) {
        window.clearInterval(statsInterval);
        statsInterval = null;
      }

      closeDataChannels();
    }
  });
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

// display bitrate statistics.
function displayStats() {
  var display = function(bitrate) {
    bitrateDiv.innerHTML = '<strong>Current Bitrate:</strong> ' +
    bitrate + ' kbits/sec';
  };

  if (pc && pc.iceConnectionState === 'connected') {
    if (adapter.browserDetails.browser === 'chrome') {
      // TODO: once https://code.google.com/p/webrtc/issues/detail?id=4321
      // lands those stats should be preferrred over the connection stats.
      pc.getStats(null, function(stats) {
        for (var key in stats) {
          var res = stats[key];
          if (timestampPrev === res.timestamp) {
            return;
          }
          if (res.type === 'googCandidatePair' &&
          res.googActiveConnection === 'true') {
            // calculate current bitrate
            var bytesNow = res.bytesReceived;
            var bitrate = Math.round((bytesNow - bytesPrev) * 8 /
            (res.timestamp - timestampPrev));
            display(bitrate);
            timestampPrev = res.timestamp;
            bytesPrev = bytesNow;
            if (bitrate > bitrateMax) {
              bitrateMax = bitrate;
            }
          }
        }
      });
    } else {
      // Firefox currently does not have data channel stats. See
      // https://bugzilla.mozilla.org/show_bug.cgi?id=1136832
      // Instead, the bitrate is calculated based on the number of
      // bytes received.
      var bytesNow = receivedSize;
      var now = (new Date()).getTime();
      var bitrate = Math.round((bytesNow - bytesPrev) * 8 /
      (now - timestampPrev));
      display(bitrate);
      timestampPrev = now;
      bytesPrev = bytesNow;
      if (bitrate > bitrateMax) {
        bitrateMax = bitrate;
      }
    }
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

// UI methods

function fallbackCopyTextToClipboard(text) {
  var textArea = document.createElement("textarea");
  textArea.value = text;
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    var successful = document.execCommand('copy');
    var msg = successful ? 'successful' : 'unsuccessful';
    console.log('Fallback: Copying text command was ' + msg);
  } catch (err) {
    console.error('Fallback: Oops, unable to copy', err);
  }

  document.body.removeChild(textArea);
}

function generateClientLink() {
  var url = window.location.href;
  if (url.split('broadcast'))
    url = window.location.href.replace('broadcast','display');
  if (!navigator.clipboard) {
    fallbackCopyTextToClipboard(url);
    return;
  }
  navigator.clipboard.writeText(url).then(function() {
    console.log('Async: Copying to clipboard was successful!');
  }, function(err) {
    console.error('Async: Could not copy text: ', err);
  });
  /* Alert the copied text */
  alert("Copied link: " + url.value);
}

/*
  Zooming and rotating video player
*/
function enableControlButtons(){
  var zoom = 1,
  rotate = 0;
  /* Grab the necessary DOM elements */
  var stage = document.getElementById('remoteVideo');
  var v = document.getElementById('remoteVideo');
  var controls = document.getElementById('video-call-controls');

  /* Array of possible browser specific settings for transformation */
  var properties = ['transform', 'WebkitTransform', 'MozTransform',
    'msTransform', 'OTransform'],
  prop = properties[0];

  /* Iterators and stuff */
  var i,j,t;
  /* Find out which CSS transform the browser supports */
  for(i=0,j=properties.length;i<j;i++){
    if(typeof stage.style[properties[i]] !== 'undefined'){
      prop = properties[i];
      break;
    }
  }
  /* Position video */
  v.style.left = 0;
  v.style.top = 0;

  /* If a button was clicked (uses event delegation)...*/
  controls.addEventListener('click',function(e){
    console.log('Click');
    t = e.target;
    if(t.nodeName.toLowerCase()==='i' || t.nodeName.toLowerCase()==='button'){
      /* Check the class name of the button and act accordingly */
      switch(t.id){
      /* Increase zoom and set the transformation */
        case 'zoom':
          zoom = zoom + 0.1;
          v.style[prop]='scale('+zoom+') rotate('+rotate+'deg)';
          break;
      /* Decrease zoom and set the transformation */
        case 'zoomout':
          zoom = zoom - 0.1;
          v.style[prop]='scale('+zoom+') rotate('+rotate+'deg)';
          break;

      /* Increase rotation and set the transformation */
        case 'turn-left':
          rotate = rotate - 90;
          v.style[prop]='rotate('+rotate+'deg) scale('+zoom+')';
          break;

      /* Reset all to default */
        case 'stop':
          zoom = 1;
          rotate = 0;
          v.style.top = 0 + 'px';
          v.style.left = 0 + 'px';
          v.style[prop]='rotate('+rotate+'deg) scale('+zoom+')';
          break;

        case 'expand':
          requestFullscreen(remoteVideo);
          break;

        case 'download':
          sendMessage({message:'request file'});
          break;

        default:
          console.log(t.id);
      }
    }
  },false);

  var requestFullscreen = function (ele) {
    if (ele.requestFullscreen) {
      ele.requestFullscreen();
    } else if (ele.webkitRequestFullscreen) {
      ele.webkitRequestFullscreen();
    } else if (ele.mozRequestFullScreen) {
      ele.mozRequestFullScreen();
    } else if (ele.msRequestFullscreen) {
      ele.msRequestFullscreen();
    } else {
      console.log('Fullscreen API is not supported.');
    }
  };
};