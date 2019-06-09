'use strict';

const pjson = require('./package.json');
const os = require('os');
const async = require('async');
const socketIO = require('socket.io');
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const config = require("./config.js");
const colors = require('colors');
const https = require("https");
const cors = require('cors');
const session = require('express-session');
const MongoStore = require('connect-mongo')(session);

var app = express();
var rooms = [];
var rpis = [];
var turnCredentials;

app.set('view engine', 'ejs');

app.use(express.static('.'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
if (process.env.NODE_ENV === 'production')
  app.use(session({
    secret: "Just a secret key",
    store: new MongoStore({
      url: process.env.MONGODB_URI || 'mongodb://'+process.env.SessionDB_HOSTNAME+':27017/webrtc-sessions'
    }),
    saveUninitialized: true,
    resave: false,
    cookie: { secure: true, maxAge: 7 * 24 * 3600 * 1000} //1 week
  }));
else
  app.use(session({
    secret: "Just a secret key",
    saveUninitialized: true,
    resave: false,
    cookie: { secure: true, maxAge: 24 * 3600 * 1000} //1 day
  }));
app.use(cors());

// Debugging
var debug = require('debug');
var d = {
  debug: debug('debug'),
  err: debug('error'),
  warn: debug('warn'),
  timer: debug('timer'),
  info: debug('info')
};

//Routes
if (process.env.AUTH === false || config.server.auth === false) {
  app.get('/display/:roomname', function (req, res) {
    d.info('Got /display/:roomname');
    var file = path.join(__dirname, 'static', 'index.html');
    res.sendFile(path.join(file));
  });
  app.get('/broadcast/:roomname', function (req, res) {
    d.info('Got /broadcast/:roomname');
    var file = path.join(__dirname, 'static', 'broadcaster.html');
    res.sendFile(path.join(file));
  });
}

app.get('/login', function(req, res){
  d.info('Got GET /login');
  res.render('login',{ login_response : { response: ''}});
});

app.get('/logout', function(req, res){
  d.info('Got GET /logout');
  req.session.destroy();
  if (req.xhr || req.headers.accept.indexOf('json') > -1) {
    return res.status(200).send('OK');
  } else {
    return res.render('login', {login_response: {response: ''}});
  }
});

app.post('/login', function(req, res) {
  d.info('Got POST /login');
  if(!req.body.token || !req.body.room) {
    if (req.xhr || req.headers.accept.indexOf('json') > -1) {
      return res.status(400).send('Bad Request.  Room name or Token missing');
    } else {
      return res.render('login', {login_response: {response: 'Not Allowed. Room name or token missing'}});
    }
  }
  req.session.type = req.body.type;
  req.session.roomName = req.body.room;
  req.session.roomToken = req.body.token;

  if (req.session.type === 'broadcast') {
    if (rooms.some(item => item.roomName === req.session.roomName)) {
      req.session.destroy();
      return res.status(401).render('login', { login_response : { response: 'Room already exists1. Not allowed'}});
    }
    rooms.push({roomName: req.session.roomName, secret: req.session.roomToken, broadcasting: false});
    console.log('Valid broadcaster!');
    req.session.broadcast_auth = true;
    res.redirect('/secure_broadcast/' + req.session.roomName);
  } else if (req.session.type === 'display') {
    res.redirect('/secure_display/' + req.session.roomName)
  } else {
    var err_res = 'Type not recognized';
    req.session.destroy();
    res.render('login', { login_response : { response: err_res}});
  }
});

app.get('/rooms', function(req, res){
  d.info('Got GET /rooms');
  var partialRooms = [];
  for (var i = 0; i < rooms.length; i++) {
    partialRooms.push({roomName: rooms[i].roomName, broadcasting: rooms[i].broadcasting});
  }
  res.json(partialRooms);
});

app.get('/secure_display/:roomname', checkIsAuth, function(req, res) {
  d.info('Got GET /secure_display' + req.params.roomname);
  res.status(200).render('index', {
    session: req.session
  });
});

app.get('/secure_broadcast/:roomname', checkRoomExistsAndAuth, function(req, res) {
  d.info('Got GET /secure_broadcast/' + req.params.roomname);
  res.status(200).render('broadcaster', {
    session: req.session
  });
});

app.get('/', function (req, res, next) {
  d.info('Got /');
  return res.json({ 'status': 'up', 'date': Date.now(), 'version': pjson.version });
});

function checkIsAuth(req, res, next){
  if (!req.session.roomToken) {
    d.warn("Not logged in!", req.session.roomToken);
    if (req.xhr || req.headers.accept.indexOf('json') > -1) {
      return res.status(401).send('Unauthorized');
    } else {
      var isBroadcast = req.originalUrl.includes('broadcast');
      return res.render('login', {
        login_response: {response: 'Authentication required'},
        type: isBroadcast ? 'broadcast' : 'display',
        roomName: req.params.roomname
      });
    }
  }

  console.log(rooms);
  console.log('requested session room name: ' + req.session.roomName);
  var r = rooms.filter(function(item) {
    return item.roomName === req.session.roomName;
  });
  if (r.length === 0)
    return res.status(404).render('login', { login_response : { response: 'Room Not Found'}});
  console.log(req.session.roomToken);
  console.log('===');
  console.log(r[0].secret);
  if (req.session.roomToken === r[0].secret) {
    req.session.auth = true;
    next();
  } else {
    return res.render('login', {login_response: {response: 'Wrong room or token'}});
  }
}

function checkRoomExistsAndAuth(req, res, next) {
  console.log(rooms);
  var foundRoom = rooms.filter(function (item) {
    return item.roomName === req.params.roomname;
  });
  if (foundRoom.length > 0 && req.session.broadcast_auth !== true) {
    req.session.destroy();
    return res.status(401).render('login', {login_response: {response: 'Room already exists. Not allowed'}});
  }

  if (!req.session.roomName || !req.session.type || !req.session.roomToken) {
    if (!req.params.roomname || !req.query.token) {
      req.session.destroy();
      return res.status(401).render('login', {login_response: {response: 'Missing parameters. Not allowed'}});
    }
    d.debug('Session Request not present', req.params.roomname, req.query.token, req.query);
    req.session.roomName = req.params.roomname;
    req.session.type = 'broadcast';
    req.session.roomToken = req.query.token;
  }

  if (foundRoom.length === 0) {
    rooms.push({roomName: req.session.roomName, secret: req.session.roomToken, broadcasting: false});
  }
  req.session.broadcast_auth = true;
  next();
}

async.series([
  // 1. HTTP
  function(callback) {
    console.log(colors.yellow("[1. HTTP]"));
    if(config.server.ws.http) {
      var http = require('http').Server(app);
      socket(http);
      http.on('error', function(err) {
        d.err('HTTP error:', err)
        if(err.code == 'EADDRINUSE') {
          callback('Port ' + config.server.ws.http + ' for HTTP backend already in use');
        }
      });
      http.listen(config.server.ws.http, function() {
        d.info('HTTP backend listening on *:' + config.server.ws.http + ' (HTTP)');
        callback(null, "HTTP backend OK");
      });
    } else {
      callback(null, "No HTTP server backend");
    }
  },
  // 2. HTTPS
  function(callback) {
    console.log(colors.yellow("[2. HTTPS]"));
    if(config.server.ws.https) {
      var fs = require('fs');
      var options = {
        key: fs.readFileSync(config.server.ws.key, 'utf8'),
        cert: fs.readFileSync(config.server.ws.cert, 'utf8')
      };
      var https = require('https').createServer(options, app);
      socket(https);
      https.on('error', function(err) {
        d.err('HTTPS backend error:', err)
        if(err.code == 'EADDRINUSE') {
          callback('Port ' + config.server.ws.https + ' for HTTPS backend already in use');
        }
      });
      https.listen(config.server.ws.https, function() {
        d.info('HTTPS backend listening on *:' + config.server.ws.https + ' (HTTPS)');
        callback(null, "HTTPS backend OK");
      });
    } else {
      callback(null, "No HTTPS users backend");
    }
  }
],
function(err, results) {
  if(err) {
    console.log(colors.red("The WebRTC signaling server failed to start"));
    console.log(err);
    process.exit(1);
  } else {
    // We're up and running
    console.log(colors.cyan("Server started!"));
    console.log(results);
  }
});

// Socket.io ws signaling server, connection/messages handling
function socket(http) {
  var io = socketIO({pingTimeout: 9000, pingInterval: 4000}).listen(http);
  io.sockets.on('connection', function (socket) {
    //this socket is authenticated, we are good to handle more events from it.
    socket.resources = {
      screen: false,
      video: true,
      audio: false
    };
    try {
      console.log(socket.conn.remoteAddress);
      var address = socket.request.connection._peername;
      console.log('New connection from ' + address.address + ':' + address.port);
    } catch (e) {
      console.log('New connection. Address not recognized.');
    }

    if (process.env.AUTH === false || config.server.auth === false) {
      console.log('AUTH DISABLED');
      socket.emit('authenticated');
      signaling(socket, null);
    } else {
      console.log('AUTH ENABLED');
      // first we need the token for you to connect with other peers
      socket.on('token', function (token) {
        d.info('Token received from frontend. Rooms: ' + rooms);
        var r = rooms.filter(function (item) {
          return item.roomName === token.roomName;
        });
        console.log(r[0].secret);
        console.log(token.value);
        if (token.value === r[0].secret) {
          if (r[0].broadcasting === true && r[0].type === 'broadcast') {
            d.warn('A broadcast is already taking place');
            return 'A broadcast is already taking place';
          }
          socket.emit('authenticated');
          signaling(socket, r[0]);
        }
      });

      //RPI initial connection
      socket.on('rpi-connect', (id, roomName, fn) => {
        d.info('Connection to admin ROOM and broadcast RPI');
        // if (!socket.rooms.hasOwnProperty('admin'))
        //   socket.join('admin');

        if (!rpis.some(e => e.id === id)) {
          rpis.push({id: id, roomName: roomName});
          socket.broadcast.emit('new-rpi', {id: id, roomName: roomName});
        }
        fn(true)
      });
    }

    // Core Signaling with no Auth option
    function signaling(socket, theroom) {
      // convenience function to log server messages on the client
      function log() {
        var array = ['Message from server:'];
        array.push.apply(array, arguments);
        socket.emit('log', array);
      }

      socket.on('message', function (message) {
        if (!message) return;
        log('Client said: ', message);
        io.sockets.in(message.room).emit('message', message);
      });

      socket.on('create', function (room) {
        log('Received request to create ' + room);
        var numClients = clientsInRoom(room);
        log('Room ' + room + ' now has ' + numClients + ' client(s)');
        removeFeed();
        socket.join(room);
        log('Client ID ' + socket.id + ' created room ' + room);
        socket.emit('created', room, socket.id);
        socket.room = room;
        if (theroom)
          theroom.broadcasting = true;
      });

      socket.on('join', function (room) {
        if (typeof room !== 'string') return;
        log('Received request to join room ' + room);
        //leave existing rooms
        removeFeed();
        var numClients = clientsInRoom(room);
        log('Room ' + room + ' now has ' + numClients + ' client(s)');

        if (numClients === 0) {
          socket.emit('no broadcaster', room);
        } else if (numClients <= 3) {
          log('Client ID ' + socket.id + ' joined room ' + room);
          // socket.emit('iceServers', turnCredentials);
          io.sockets.in(room).emit('join', room);
          socket.join(room);
          socket.emit('joined', room, socket.id, numClients);
          socket.room = room;
          io.sockets.in(room).emit('ready');
        } else { // max 3 clients
          socket.emit('full', room);
        }
      });

      function clientsInRoom(room) {
        var clientsInRoom = io.sockets.adapter.rooms[room];
        var numClients = clientsInRoom ? Object.keys(clientsInRoom.sockets).length : 0;
        return numClients;
      }

      function removeFeed(type) {
        if (socket.room) {
          var numClientsInRoom = clientsInRoom(socket.room);
          io.sockets.in(socket.room).emit('remove', {
            id: socket.id,
            peers: numClientsInRoom - 1,
            type: type
          });
          if (!type) {
            socket.leave(socket.room);
            socket.room = undefined;
          }
          //FIXME we need to find a better way to clear rooms list when room finished
          if (theroom && clientsInRoom(theroom.roomName) === 0) {
            var t = setTimeout(function () {
              if (clientsInRoom(theroom.roomName) === 0) {
                d.debug('0 sockets in room! Clearing...');
                theroom.broadcasting = false;
                console.log('Room ' + theroom.roomName + ' deleted from list!');
                rooms = rooms.filter(function (item) {
                  return item.roomName !== theroom.roomName;
                });
                d.info('Rooms: ' + JSON.stringify(rooms));
              }
              clearTimeout(t);
            }, 5000);
          }
        }
      }

      socket.on('disconnect', function () {
        console.log('Got disconnected');
        removeFeed();
      });
      socket.on('leave', function () {
        removeFeed();
      });

      socket.on('ipaddr', function () {
        var ifaces = os.networkInterfaces();
        for (var dev in ifaces) {
          ifaces[dev].forEach(function (details) {
            if (details.family === 'IPv4' && details.address !== '127.0.0.1') {
              socket.emit('ipaddr', details.address);
            }
          });
        }
      });

      // support for logging full webrtc traces to stdout
      socket.on('trace', function (data) {
        console.log('trace', JSON.stringify(
        [data.type, data.session, data.prefix, data.peer, data.time, data.value]
        ));
      });

      //if turn is enabled we will provide turn servers access on connection
      if (process.env.TURN_ENABLED === 'true' || config.server.turn.enabled === true) {

        let filterPaths = function filterPaths(arr) {
          var l = arr.length, i;
          var a = [];
          for (i = 0; i < l; i++) {
            var item = arr[i];
            var v = item.url;
            if (!!v) {
              item.urls = v;
              delete item.url;
            }
            a.push(item);
          }
          return a;
        }

        var options = {
          host: "global.xirsys.net",
          path: "/_turn/" + process.env.XIRSYS_APPNAME || config.server.turn.appName,
          method: "PUT",
          headers: {
            "Authorization": "Basic " + new Buffer((process.env.XIRSYS_USERNAME || config.server.turn.username)
            + ":" + (process.env.XIRSYS_SECRET || config.server.turn.secret)).toString("base64")
          }
        };
        var httpreq = https.request(options, function (httpres) {
          var str = "";
          httpres.on("data", function (data) {
            str += data;
          });
          httpres.on("error", function (e) {
            console.log("error: ", e);
          });
          httpres.on("end", function () {
            try {
              turnCredentials = JSON.parse(str).v.iceServers;
              // console.log("ICE List: ", turnCredentials);
              turnCredentials = filterPaths(turnCredentials);
              socket.emit('iceServers', turnCredentials);
            } catch (e) {
              console.error(e);
            }
          });
        });
        httpreq.end();
      } else {
        socket.emit('iceServers', [{'urls': 'stun:u2.xirsys.com'}]);
      }
    }
  });
}
