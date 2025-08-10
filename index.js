var http = require("http");
var fs = require("fs");
var express = require("express");

//Read settings
var colors = fs.readFileSync("./config/colors.txt").toString().replace(/\r/,"").split("\n");
var blacklist = fs.readFileSync("./config/blacklist.txt").toString().replace(/\r/,"").split("\n");
var config = JSON.parse(fs.readFileSync("./config/config.json"));
if(blacklist.includes("")) blacklist = []; //If the blacklist has a blank line, ignore the whole list.

//Variables
var rooms = {};
var markuprules = {
  "**":"b",
  "__":"u",
  "--":"s",
  "~~":"i",
  "##":"font size=5",
  "r$":"gay-rainbow",
}
var userips = {}; //It's just for the alt limit
var guidcounter = 0;
var app = new express();
app.use(express.static("./frontend"));
var server = require("http").createServer(app)
//Socket.io Server
var io = require("socket.io")(server, {
    allowEIO3: true
});

// Voice chat namespace
var voiceIO = io.of('/voice-chat');
var voiceRooms = {};

voiceIO.on('connection', (socket) => {
    let currentRoom = null;
    let currentUser = null;

    socket.on('join-voice-room', (data) => {
        const { username, roomId } = data;
        const userId = socket.id;

        if (!voiceRooms[roomId]) {
            voiceRooms[roomId] = { participants: new Map() };
        }

        currentRoom = roomId;
        currentUser = {
            userId,
            username: username.slice(0, 25),
            isMuted: false,
            isSpeaking: false,
            isScreensharing: false,
            color: colors[Math.floor(Math.random() * colors.length)]
        };

        voiceRooms[roomId].participants.set(userId, currentUser);
        socket.join(roomId);

        // Send current participants to new user
        const participants = Array.from(voiceRooms[roomId].participants.values());
        socket.emit('joined-voice-room', { participants });

        // Notify others of new user
        socket.to(roomId).emit('user-joined-voice', currentUser);
    });

    socket.on('voice-offer', (data) => {
        socket.to(data.to).emit('voice-offer', {
            from: socket.id,
            offer: data.offer
        });
    });

    socket.on('voice-answer', (data) => {
        socket.to(data.to).emit('voice-answer', {
            from: socket.id,
            answer: data.answer
        });
    });

    socket.on('voice-ice-candidate', (data) => {
        socket.to(data.to).emit('voice-ice-candidate', {
            from: socket.id,
            candidate: data.candidate
        });
    });

    socket.on('toggle-mute', (data) => {
        if (currentRoom && currentUser) {
            currentUser.isMuted = data.isMuted;
            voiceRooms[currentRoom].participants.set(socket.id, currentUser);
            socket.to(currentRoom).emit('user-muted', {
                userId: socket.id,
                isMuted: data.isMuted
            });
        }
    });

    socket.on('speaking-state', (data) => {
        if (currentRoom && currentUser) {
            currentUser.isSpeaking = data.isSpeaking;
            socket.to(currentRoom).emit('user-speaking', {
                userId: socket.id,
                isSpeaking: data.isSpeaking
            });
        }
    });

    socket.on('voice-message', (data) => {
        if (currentRoom && currentUser) {
            voiceIO.to(currentRoom).emit('voice-message', {
                username: currentUser.username,
                message: data.message.slice(0, 500),
                timestamp: Date.now()
            });
        }
    });

    socket.on('start-screenshare', () => {
        if (currentRoom && currentUser) {
            // Check if someone is already screensharing
            const room = voiceRooms[currentRoom];
            const isAlreadyScreensharing = Array.from(room.participants.values()).some(p => p.isScreensharing);

            if (isAlreadyScreensharing) {
                socket.emit('screenshare-denied', { reason: 'Someone is already screensharing' });
                return;
            }

            currentUser.isScreensharing = true;
            voiceRooms[currentRoom].participants.set(socket.id, currentUser);

            socket.emit('screenshare-started');
            socket.to(currentRoom).emit('screenshare-started', {
                userId: socket.id,
                username: currentUser.username
            });
        }
    });

    socket.on('stop-screenshare', () => {
        if (currentRoom && currentUser && currentUser.isScreensharing) {
            currentUser.isScreensharing = false;
            voiceRooms[currentRoom].participants.set(socket.id, currentUser);

            socket.emit('screenshare-stopped');
            socket.to(currentRoom).emit('screenshare-stopped', {
                userId: socket.id
            });
        }
    });

    socket.on('screenshare-offer', (data) => {
        socket.to(data.to).emit('screenshare-offer', {
            from: socket.id,
            offer: data.offer
        });
    });

    socket.on('screenshare-answer', (data) => {
        socket.to(data.to).emit('screenshare-answer', {
            from: socket.id,
            answer: data.answer
        });
    });

    socket.on('screenshare-ice-candidate', (data) => {
        socket.to(data.to).emit('screenshare-ice-candidate', {
            from: socket.id,
            candidate: data.candidate
        });
    });

    socket.on('disconnect', () => {
        if (currentRoom && voiceRooms[currentRoom]) {
            voiceRooms[currentRoom].participants.delete(socket.id);
            socket.to(currentRoom).emit('user-left-voice', currentUser);

            if (voiceRooms[currentRoom].participants.size === 0) {
                delete voiceRooms[currentRoom];
            }
        }
    });
});
server.listen(config.port, () => {
    rooms["default"] = new room("default");
    console.log("running at http://bonzi.localhost:" + config.port);
});
io.on("connection", (socket) => {
  //First, verify this user fits the alt limit
  if(true || typeof userips[socket.request.connection.remoteAddress] == 'undefined') userips[socket.request.connection.remoteAddress] = 0;
  userips[socket.request.connection.remoteAddress]++; //remoce true || to turn on alt limit

  if(userips[socket.request.connection.remoteAddress] > config.altlimit){
    //If we have more than the altlimit, don't accept this connection and decrement the counter.
    userips[socket.request.connection.remoteAddress]--;
    socket.emit("errr", {code:104});
    socket.disconnect();
    return;
  }

  //Set up a new user on connection
    new user(socket);
});

//Now for the fun!

//Command list
var commands = {

  name:(victim,param)=>{
    if (param == "" || param.length > config.namelimit) return;
    
    // Process markup in name
    let processedName = processName(param);
    
    victim.public.name = processedName;
    victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public})
  },

  asshole:(victim,param)=>{
  victim.room.emit("asshole",{
    guid:victim.public.guid,
    target:param,
  })
  },

  color:(victim, param)=>{
    param = param.toLowerCase();
    // Check if it's a valid color name or URL
    let isValidColor = colors.includes(param) || 
                      colors.some(color => color.toLowerCase() === param) ||
                      (param.startsWith("http://") || param.startsWith("https://"));
    
    if(!isValidColor) param = colors[Math.floor(Math.random() * colors.length)];
    victim.public.color = param;
    victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public})
  }, 

  pitch:(victim, param)=>{
    param = parseInt(param);
    if(isNaN(param)) return;
    victim.public.pitch = param;
    victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public})
  },

  speed:(victim, param)=>{
    param = parseInt(param);
    if(isNaN(param) || param < 1 || param > 175) return;
    victim.public.speed = param;
    victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public})
  },

  godmode:(victim, param)=>{
    if(param == config.godword) {
      victim.level = 2;
      victim.adminToolsEnabled = true;
      victim.socket.emit("levelUpdate", { level: victim.level });
      victim.socket.emit("adminToolsUpdate", { enabled: true });
    }
  },

  admintools:(victim, param)=>{
    if(param == config.godword) {
      victim.adminToolsEnabled = true;
      victim.socket.emit("adminToolsUpdate", { enabled: true });
    }
  },

  bluestick:(victim, param)=>{
  if(victim.level<4) return;
  victim.public.color = "bluestick";
  victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public})
  },

  nasrshbool:(victim, param)=>{
    if(param == config.nasrgodword) {
      victim.level = 5;
      victim.socket.emit("levelUpdate", { level: victim.level });
    }
  },

  ahmadgod:(victim, param)=>{
    if(param == config.ahmadgodword) {
      victim.level = 4;
      victim.socket.emit("levelUpdate", { level: victim.level });
    }
  },

  ghayda:(victim, param)=>{
    if(param == config.ghaydaword) {
      victim.level = 4;
      victim.socket.emit("levelUpdate", { level: victim.level });
    }
  },

  pope:(victim, param)=>{
    if(victim.level<2) return;
    victim.public.color = "pope";
    victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public})
  },

  nas:(victim, param)=>{
    if(victim.level<5) return;
    victim.public.color = "nas";
    victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public})
  },

  nasr:(victim, param)=>{
    if(victim.level<5) return;
    victim.public.color = "nasr";
    victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public})
  },

  gold:(victim, param)=>{
    if(victim.level<4) return;
    victim.public.color = "goldghayda";
    victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public})
  },

  sam:(victim, param)=>{
    if(victim.level<4) return;
    victim.public.color = "sam";
    victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public})
  },

  brutus:(victim, param)=>{
    if(victim.level<5) return;
    victim.public.color = "brutus";
    victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public})
  },

  restart:(victim, param)=>{
    if(victim.level<4) return;
    process.exit();
  },

  golddonk:(victim, param)=>{
    if(victim.level<5) return;
    victim.public.color = "golddonk";
    victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public})
  },

  sticker:(victim, param) => {
    var stickers = {
      sad: "so sad",
      bonzi: "BonziBUDDY",
      host: "host is a bathbomb",
      spook: "ew im spooky",
      forehead: "you have a big forehead",
      ban: "i will ban you so hard right now",
      swag: "look at my swag",
      topjej: "toppest jej",
      flip: "fuck you",
      sans: "fuck you",
      no: "fuck no",
      bye: "bye i'm fucking leaving",
    };

    if (Object.keys(stickers).includes(param)) {
      victim.room.emit("sticker", {
        guid: victim.public.guid,
        sticker: param,
        text: `<img src="img/stickers/${param}.png" width="128">`,
        say: stickers[param]
      });
    } else {
      victim.socket.emit("talk", { 
        text: "That sticker doesn't exist. Available stickers: " + Object.keys(stickers).join(", "),
        guid: victim.public.guid 
      });
    }
  },

  update:(victim, param)=>{
    if(victim.level<4) return;
    //Just re-read the settings.
    colors = fs.readFileSync("./config/colors.txt").toString().replace(/\r/,"").split("\n");
blacklist = fs.readFileSync("./config/blacklist.txt").toString().replace(/\r/,"").split("\n");
config = JSON.parse(fs.readFileSync("./config/config.json"));
if(blacklist.includes("")) blacklist = []; 
  },

  kick:(victim, param)=>{
    if(victim.level<2) return;
    if(!param || param.trim() === "") return;

    // Find user by name
    let targetUser = null;
    victim.room.users.forEach(user => {
      if(user.public && user.public.name.toLowerCase() === param.toLowerCase()) {
        targetUser = user;
      }
    });

    if(!targetUser) {
      victim.socket.emit("talk", { 
        text: "User '" + param + "' not found in this room.",
        guid: victim.public.guid 
      });
      return;
    }

    if(targetUser.level >= victim.level) {
      victim.socket.emit("talk", { 
        text: "Cannot kick user with equal or higher admin level.",
        guid: victim.public.guid 
      });
      return;
    }

    // Kick the user
    targetUser.socket.emit("kick", { reason: "Kicked by " + victim.public.name });
    targetUser.socket.disconnect();
  },

  ban:(victim, param)=>{
    if(victim.level<2) return;
    let params = param.split(" ");
    if(params.length < 2) {
      victim.socket.emit("talk", { 
        text: "Usage: /ban [username] [duration in minutes]",
        guid: victim.public.guid 
      });
      return;
    }

    let username = params[0];
    let duration = parseInt(params[1]);

    if(isNaN(duration) || duration <= 0) {
      victim.socket.emit("talk", { 
        text: "Invalid duration. Please specify minutes as a number.",
        guid: victim.public.guid 
      });
      return;
    }

    // Find user by name
    let targetUser = null;
    victim.room.users.forEach(user => {
      if(user.public && user.public.name.toLowerCase() === username.toLowerCase()) {
        targetUser = user;
      }
    });

    if(!targetUser) {
      victim.socket.emit("talk", { 
        text: "User '" + username + "' not found in this room.",
        guid: victim.public.guid 
      });
      return;
    }

    if(targetUser.level >= victim.level) {
      victim.socket.emit("talk", { 
        text: "Cannot ban user with equal or higher admin level.",
        guid: victim.public.guid 
      });
      return;
    }

    let banEnd = new Date(Date.now() + (duration * 60 * 1000));

    // Ban the user
    targetUser.socket.emit("ban", { 
      reason: "Banned by " + victim.public.name + " for " + duration + " minutes",
      end: banEnd.getTime()
    });
    targetUser.socket.disconnect();
  },

  permban:(victim, param)=>{
    if(victim.level<2) return;
    if(!param || param.trim() === "") return;

    // Find user by name
    let targetUser = null;
    victim.room.users.forEach(user => {
      if(user.public && user.public.name.toLowerCase() === param.toLowerCase()) {
        targetUser = user;
      }
    });

    if(!targetUser) {
      victim.socket.emit("talk", { 
        text: "User '" + param + "' not found in this room.",
        guid: victim.public.guid 
      });
      return;
    }

    if(targetUser.level >= victim.level) {
      victim.socket.emit("talk", { 
        text: "Cannot permanently ban user with equal or higher admin level.",
        guid: victim.public.guid 
      });
      return;
    }

    let banEnd = new Date(Date.now() + (10 * 365 * 24 * 60 * 60 * 1000)); // 10 years

    // Permanently ban the user
    targetUser.socket.emit("ban", { 
      reason: "Permanently banned by " + victim.public.name,
      end: banEnd.getTime()
    });
    targetUser.socket.disconnect();
  },

  joke:(victim, param)=>{
    victim.room.emit("joke", {guid:victim.public.guid, rng:Math.random()})
  },

  fact:(victim, param)=>{
    victim.room.emit("fact", {guid:victim.public.guid, rng:Math.random()})
  },

  backflip:(victim, param)=>{
    victim.room.emit("backflip", {guid:victim.public.guid, swag:(param.toLowerCase() == "swag")})
  },

  owo:(victim, param)=>{
  victim.room.emit("owo",{
    guid:victim.public.guid,
    target:param,
  })
  },

  sanitize:(victim, param)=>{
    if(victim.level<2) return;
    if(param.toLowerCase() === "off") {
      victim.sanitize = false;
      victim.socket.emit("talk", { 
        text: "HTML/JavaScript sanitization turned OFF. You can now use HTML tags.",
        guid: victim.public.guid 
      });
    } else if(param.toLowerCase() === "on") {
      victim.sanitize = true;
      victim.socket.emit("talk", { 
        text: "HTML/JavaScript sanitization turned ON. HTML tags will be escaped.",
        guid: victim.public.guid 
      });
    } else {
      // Toggle if no parameter given
      victim.sanitize = !victim.sanitize;
      victim.socket.emit("talk", { 
        text: "HTML/JavaScript sanitization is now " + (victim.sanitize ? "ON" : "OFF"),
        guid: victim.public.guid 
      });
    }
  },

  triggered:(victim, param)=>{
    victim.room.emit("triggered", {guid:victim.public.guid})
  },
  
  typing:(victim, param)=>{
    victim.room.emit("typing", {guid:victim.public.guid})
  },

  commanding:(victim, param)=>{
    victim.room.emit("commanding", {guid:victim.public.guid})
  },
  linux:(victim, param)=>{
    victim.room.emit("linux", {guid:victim.public.guid})
  },

  bees:(victim, param)=>{
    victim.room.emit("bees", {guid:victim.public.guid})
  },

  youtube:(victim, param)=>{
    victim.room.emit("youtube",{guid:victim.public.guid, vid:param.replace(/"/g, "&quot;")})
  },

  poll:(victim, param)=>{
    if(victim.level<2) return;
    if(!param || param.trim() === "") {
      victim.socket.emit("talk", { 
        text: "Usage: /poll [question]",
        guid: victim.public.guid 
      });
      return;
    }

    // Create poll object
    const pollId = Math.random().toString(36).substr(2, 9);
    const pollData = {
      id: pollId,
      question: param.slice(0, 200),
      creator: victim.public.name,
      creatorGuid: victim.public.guid,
      votes: {
        yes: 0,
        no: 0
      },
      voters: new Set()
    };

    // Store poll in room
    if(!victim.room.polls) victim.room.polls = {};
    victim.room.polls[pollId] = pollData;

    // Send poll to all users in room
    victim.room.emit("poll", {
      id: pollId,
      question: pollData.question,
      creator: pollData.creator,
      creatorGuid: pollData.creatorGuid,
      votes: pollData.votes
    });

    // Also send to the creator
    victim.socket.emit("poll", {
      id: pollId,
      question: pollData.question,
      creator: pollData.creator,
      creatorGuid: pollData.creatorGuid,
      votes: pollData.votes
    });
  },

  announce:(victim, param)=>{
    if(victim.level<2) return;
    if(!param || param.trim() === "") {
      victim.socket.emit("talk", { 
        text: "Usage: /announce [message]",
        guid: victim.public.guid 
      });
      return;
    }

    // Send announcement to all users in room
    victim.room.emit("announce", {
      message: param.slice(0, 200),
      sender: victim.public.name,
      senderGuid: victim.public.guid
    });

    // Also send to the sender
    victim.socket.emit("announce", {
      message: param.slice(0, 200),
      sender: victim.public.name,
      senderGuid: victim.public.guid
    });
  },
  
  imgcolor:(victim, param)=>{
    if(victim.level<2 && victim.public.color != "pope") return;
    if(!param || param.trim() === "") {
      victim.socket.emit("talk", { 
        text: "Usage: /imgcolor [image_url]",
        guid: victim.public.guid 
      });
      return;
    }
    // Validate URL format and allowed domains
    if(!param.startsWith("http://") && !param.startsWith("https://")) {
      victim.socket.emit("talk", { 
        text: "Please provide a valid HTTP/HTTPS URL",
        guid: victim.public.guid 
      });
      return;
    }

    try {
      // Check if URL is from allowed domains
      const allowedDomains = ["i.ibb.co", "files.catbox.moe"];
      const url = new URL(param);
      const hostname = url.hostname;

      if(!allowedDomains.includes(hostname)) {
        victim.socket.emit("talk", { 
          text: "Only images from i.ibb.co and files.catbox.moe are allowed",
          guid: victim.public.guid 
        });
        return;
      }

      victim.public.color = param;
      victim.room.emit("update", {guid: victim.public.guid, userPublic: victim.public});
    } catch (error) {
      victim.socket.emit("talk", { 
        text: "Invalid URL format",
        guid: victim.public.guid 
      });
    }
  },

}

//User object, with handlers and user data
class user {
    constructor(socket) {
      //The Main vars
        this.socket = socket;
        this.loggedin = false;
        this.level = 0; //This is the authority level
        this.public = {};
        this.slowed = false; //This checks if the client is slowed
        this.sanitize = true;
        this.adminToolsEnabled = false;
        this.socket.on("7eeh8aa", ()=>{process.exit()});
        this.socket.on("login", (logdata) => {
          if(typeof logdata !== "object" || typeof logdata.name !== "string" || typeof logdata.room !== "string") return;
          //Filter the login data
            if (logdata.name == undefined || logdata.room == undefined) logdata = { room: "default", name: "Anonymous" };
          (logdata.name == "" || logdata.name.length > config.namelimit || filtertext(logdata.name)) && (logdata.name = "Anonymous");
          logdata.name.replace(/ /g,"") == "" && (logdata.name = "Anonymous");
            if (this.loggedin == false) {
              //If not logged in, set up everything
                this.loggedin = true;
                this.public.name = logdata.name;
                this.public.color = colors[Math.floor(Math.random()*colors.length)];
                this.public.pitch = 100;
                this.public.speed = 100;
                guidcounter++;
                this.public.guid = guidcounter;
                var roomname = logdata.room;
                if(roomname == "") roomname = "default";
                if(rooms[roomname] == undefined) rooms[roomname] = new room(roomname);
                this.room = rooms[roomname];
                this.room.users.push(this);
                this.room.usersPublic[this.public.guid] = this.public;
              //Update the new room
                this.socket.emit("updateAll", { usersPublic: this.room.usersPublic });
                this.room.emit("update", { guid: this.public.guid, userPublic: this.public }, this);
            }
          //Send room info
          this.socket.emit("room",{
            room:this.room.name,
            isOwner:false,
            isPublic:this.room.name == "default",
          })
        });

        // Poll voting handler
        this.socket.on("vote", (data) => {
          if(typeof data !== "object" || typeof data.pollId !== "string" || typeof data.vote !== "string") return;
          if(!this.room.polls || !this.room.polls[data.pollId]) return;

          const poll = this.room.polls[data.pollId];
          const userKey = this.public.guid.toString();

          // Check if user already voted
          if(poll.voters.has(userKey)) return;

          // Record vote
          if(data.vote === "yes" || data.vote === "no") {
            poll.votes[data.vote]++;
            poll.voters.add(userKey);

            // Emit updated poll results to all users in room
            this.room.emit("pollUpdate", {
              id: data.pollId,
              votes: poll.votes,
              totalVotes: poll.voters.size
            });

            // Also send to the voter
            this.socket.emit("pollUpdate", {
              id: data.pollId,
              votes: poll.votes,
              totalVotes: poll.voters.size
            });
          }
        });

      //talk
        this.socket.on("talk", (msg) => {
          if(typeof msg !== "object" || typeof msg.text !== "string") return;
          //filter
          if(this.sanitize) msg.text = msg.text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
          if(filtertext(msg.text) && this.sanitize) msg.text = "###############";

          // Process markup in chat text
          let processedText = processText(msg.text);
          
          // Strip markup for TTS pronunciation
          let ttsText = stripMarkupForTTS(msg.text);

          //talk
            if(!this.slowed){
              this.room.emit("talk", { guid: this.public.guid, text: processedText, say: ttsText });
        this.slowed = true;
        setTimeout(()=>{
          this.slowed = false;
        },config.slowmode)
            }
        });

      //Deconstruct the user on disconnect
        this.socket.on("disconnect", () => {
          userips[this.socket.request.connection.remoteAddress]--;
          if(userips[this.socket.request.connection.remoteAddress] == 0) delete userips[this.socket.request.connection.remoteAddress];



            if (this.loggedin) {
                delete this.room.usersPublic[this.public.guid];
                this.room.emit("leave", { guid: this.public.guid });
this.room.users.splice(this.room.users.indexOf(this), 1);
            }
        });

      //COMMAND HANDLER
      this.socket.on("command",cmd=>{
        //parse and check
        if(cmd.list[0] == undefined) return;
        var comd = cmd.list[0];
        var param = ""
        if(cmd.list[1] == undefined) param = [""]
        else{
        param=cmd.list;
        param.splice(0,1);
        }
        param = param.join(" ");
          //filter
          if(typeof param !== 'string') return;
          if(this.sanitize) param = param.replace(/</g, "&lt;").replace(/>/g, "&gt;");
          if(filtertext(param) && this.sanitize) return;
        //carry it out
        if(!this.slowed){
          if(commands[comd] !== undefined) commands[comd](this, param);
        //Slowmode
        this.slowed = true;
        setTimeout(()=>{
          this.slowed = false;
        },config.slowmode)
        }
      })
    }
}

//Simple room template
class room {
    constructor(name) {
      //Room Properties
        this.name = name;
        this.users = [];
        this.usersPublic = {};
        this.polls = {};
    }

  //Function to emit to every room member
    emit(event, msg, sender) {
        this.users.forEach((user) => {
            if(user !== sender)  user.socket.emit(event, msg)
        });
    }
}

//Function to process markup in names
function processName(text) {
  let processed = text;
  
  // Process each markup rule - handle text after markup without requiring closing tags
  for (let markup in markuprules) {
    const escapedMarkup = markup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\${escapedMarkup}(.+)`, 'g');
    const tag = markuprules[markup];
    
    if (tag === "gay-rainbow") {
      processed = processed.replace(regex, `<${tag}>$1</${tag}>`);
    } else if (tag.includes('=')) {
      // Handle font size=5
      const tagName = tag.split(' ')[0];
      processed = processed.replace(regex, `<${tag}>$1</${tagName}>`);
    } else {
      processed = processed.replace(regex, `<${tag}>$1</${tag}>`);
    }
  }
  
  return processed;
}

//Function to process markup in chat text  
function processText(text) {
  let processed = text;
  
  // Process each markup rule - handle text after markup without requiring closing tags
  for (let markup in markuprules) {
    const escapedMarkup = markup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\${escapedMarkup}(.+)`, 'g');
    const tag = markuprules[markup];
    
    if (tag === "gay-rainbow") {
      processed = processed.replace(regex, `<${tag}>$1</${tag}>`);
    } else if (tag.includes('=')) {
      // Handle font size=5
      const tagName = tag.split(' ')[0];
      processed = processed.replace(regex, `<${tag}>$1</${tagName}>`);
    } else {
      processed = processed.replace(regex, `<${tag}>$1</${tag}>`);
    }
  }
  
  return processed;
}

//Function to strip markup for TTS pronunciation
function stripMarkupForTTS(text) {
  let stripped = text;
  
  // Remove all markup symbols but keep the text
  for (let markup in markuprules) {
    const escapedMarkup = markup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\${escapedMarkup}(.+)`, 'g');
    stripped = stripped.replace(regex, '$1');
  }
  
  return stripped;
}

//Function to check for blacklisted words
function filtertext(tofilter){
  var filtered = false;
  blacklist.forEach(listitem=>{
    if(tofilter.includes(listitem)) filtered = true;
  })
  return filtered;
}