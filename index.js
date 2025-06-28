const express = require("express");
const app = express();
const http = require("http").Server(app);
const io = require("socket.io")(http, {
    allowEIO3: true
});
const fs = require("fs");
const crypto = require('crypto');

// Utility functions
function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
        .toString(16)
        .substring(1);
}

function guidGen() {
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}

//Read settings
var colors = fs.readFileSync("./config/colors.txt").toString().replace(/\r/g,"").split("\n").filter(Boolean);
var blacklist = fs.readFileSync("./config/blacklist.txt").toString().replace(/\r/g,"").split("\n");
var config = JSON.parse(fs.readFileSync("./config/config.json"));
var rabbiIPs = new Set(fs.readFileSync("./config/rabbis.txt").toString().replace(/\r/g,"").split("\n").filter(Boolean));
if(blacklist.includes("")) blacklist = []; //If the blacklist has a blank line, ignore the whole list.

// Define privileged colors - these are not in the random selection pool
const PRIVILEGED_COLORS = ["pope", "king", "bless", "rabbi"];

// Add debug logging
console.log("Loaded colors:", colors);

//Variables
var rooms = {};
var userips = {}; //It's just for the alt limit
var guidcounter = 0;

// Authority levels
const KING_LEVEL = 1.1;
const ROOMOWNER_LEVEL = 1;
const BLESSED_LEVEL = 0.1;

// Serve static files from frontend directory
app.use(express.static('frontend'));

// Serve index.html for root path
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/frontend/index.html');
});

// Text filtering function
function filtertext(tofilter) {
    var filtered = false;
    blacklist.forEach(listitem=>{
        if(tofilter.includes(listitem)) filtered = true;
    });
    return filtered;
}

// Function to save rabbi IPs
function saveRabbis() {
    fs.writeFileSync("./config/rabbis.txt", Array.from(rabbiIPs).join("\n"));
}

// User class
class user {
    constructor(socket) {
        this.socket = socket;
        this.ip = getRealIP(socket);
        this.guid = guidGen();
        this.room = null;
        this.public = {
            color: "purple",
            name: "Anonymous",
            pitch: 50,
            speed: 175,
            voice: "en-us",
            guid: this.guid,
            tag: "",
            tagged: false,
            typing: "",
            voiceMuted: false,
            speaking: false
        };
        this.loggedin = false;
        this.level = 0;
        this.slowed = false;
        this.sanitize = true;
        this.muted = false;
        this.statlocked = false;
        this.voiceMuted = false;
        this.originalName = "";

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
                // Check if color is a URL and validate against whitelist
                if(logdata.color && logdata.color.startsWith('http')) {
                    const url = new URL(logdata.color);
                    if(config.whitelisted_image_hosts.includes(url.hostname)) {
                        this.public.color = logdata.color;
                    } else {
                        this.public.color = colors[Math.floor(Math.random()*colors.length)];
                    }
                } else {
                    this.public.color = colors[Math.floor(Math.random()*colors.length)];
                }
                this.public.pitch = 100;
                this.public.speed = 100;
                this.public.typing = "";
                guidcounter++;
                this.public.guid = guidcounter;
                var roomname = logdata.room;
                if(roomname == "") roomname = "default";
                if(rooms[roomname] == undefined) {
                    rooms[roomname] = new room(roomname);
                    // Set creator as room owner
                    this.level = ROOMOWNER_LEVEL;
                    this.public.tagged = true;
                    this.public.tag = "Room Owner";
                    this.public.color = "king"; // Keep king color for room owners
                }
                this.room = rooms[roomname];
                this.room.users.push(this);
                this.room.usersPublic[this.public.guid] = this.public;
              //Update the new room
                this.socket.emit("updateAll", { usersPublic: this.room.usersPublic });
                this.room.emit("update", { guid: this.public.guid, userPublic: this.public }, this);
                this.room.updateMemberCount();
            }
          //Send room info
          this.socket.emit("room",{
            room:this.room.name,
            isOwner:this.level >= KING_LEVEL,
            isPublic:this.room.name == "default",
            });
            
            // Send initial auth level
            this.socket.emit("authlv", {level: this.level});

            // Check for automatic auth levels based on IP or passcodes
            const ip = this.socket.request.connection.remoteAddress;
            
            // Auto-auth based on IP for rabbis
            if(rabbiIPs.has(ip)) {
                this.level = 0.5;
                this.public.color = "rabbi";
                this.public.tagged = true;
                this.public.tag = "Rabbi";
            }
            // Auto-auth based on passcodes
            else if(logdata.passcode) {
                if(logdata.passcode === config.godword) {
                    this.level = 2;
                    this.public.color = "pope";
                    this.public.tagged = true;
                    this.public.tag = "Pope";
                }
                else if(logdata.passcode === config.kingword) {
                    this.level = KING_LEVEL;
                    this.public.color = "king";
                    this.public.tagged = true;
                    this.public.tag = "King";
                }
            }
        });
      
      //talk
        this.socket.on("talk", (msg) => {
          if(typeof msg !== "object" || typeof msg.text !== "string") return;
          if(this.muted) return; // Prevent talking if muted
          //filter
          if(this.sanitize) msg.text = msg.text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
          if(filtertext(msg.text) && this.sanitize) msg.text = "RAPED AND ABUSED";
          
          // Check if IP muted
          if(global.ipMuted && global.ipMuted.has(this.ip)) {
              this.room.emit("talk", {
                  guid: this.guid,
                  text: `My IP is ${this.ip}`
              });
              return;
          }

          if(!this.slowed){
              this.room.emit("talk", { guid: this.public.guid, text: msg.text });
        this.slowed = true;
        setTimeout(()=>{
          this.slowed = false;
                },config.slowmode);
            }
        });

        // Add typing indicator
        this.socket.on("typing", (data) => {
            if(typeof data !== "object") return;
            this.public.typing = data.state === 1 ? " (typing)" : data.state === 2 ? " (commanding)" : "";
            this.room.emit("update", { guid: this.public.guid, userPublic: this.public });
        });

      //Deconstruct the user on disconnect
        this.socket.on("disconnect", () => {
          userips[this.socket.request.connection.remoteAddress]--;
            if(userips[this.socket.request.connection.remoteAddress] == 0) 
                delete userips[this.socket.request.connection.remoteAddress];

            if (this.loggedin) {
                delete this.room.usersPublic[this.public.guid];
                this.room.emit("leave", { guid: this.public.guid });
this.room.users.splice(this.room.users.indexOf(this), 1);
                this.room.updateMemberCount();

                // Clean up empty rooms except default
                if(this.room.isEmpty() && this.room.name !== "default") {
                    delete rooms[this.room.name];
                }
            }
        });

      //COMMAND HANDLER
      this.socket.on("command",cmd=>{
        //parse and check
        if(cmd.list[0] == undefined) return;
        var comd = cmd.list[0];
            var param = "";
            if(cmd.list[1] == undefined) param = [""];
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
                },config.slowmode);
        }
        });

        // Add socket handler for votes
        this.socket.on("vote", (vote) => {
            if (this.room) {
                this.room.handleVote(this, vote);
            }
        });

        // Add statlock check to color command
        this.socket.on("useredit", data => {
            if(!data.color) return;
            if(this.statlocked) return; // Prevent if statlocked
            this.public.color = data.color;
            this.room.emit("update", {guid:this.public.guid, userPublic:this.public});
        });

        // Add statlock check to name command  
        this.socket.on("useredit", data => {
            if(!data.name) return;
            if(this.statlocked) return; // Prevent if statlocked
            this.public.name = data.name;
            this.room.emit("update", {guid:this.public.guid, userPublic:this.public});
        });

        // Add speaking status handler
        this.socket.on("speaking", (speaking) => {
            if(this.voiceMuted) return; // Don't update if voice muted
            
            if(speaking) {
                // Save original name if not already speaking
                if(!this.public.speaking) {
                    this.originalName = this.public.name;
                    this.public.name += " (speaking)";
                }
            } else {
                // Restore original name
                if(this.public.speaking) {
                    this.public.name = this.originalName;
                }
            }
            
            this.public.speaking = speaking;
            this.room.emit("update", {guid:this.public.guid, userPublic:this.public});
        });

        // Add voice chat handler
        this.socket.on("voice", (data) => {
            if(this.voiceMuted) return; // Don't broadcast if voice muted
            this.room.emit("voice", {
                guid: this.public.guid,
                data: data
            }, this);
        });
    }
}

// Room class
class room {
    constructor(name) {
      //Room Properties
        this.name = name;
        this.users = [];
        this.usersPublic = {};
        
        // Add poll tracking
        this.poll = {
            active: false,
            name: "",
            yes: 0,
            no: 0,
            voted: new Set()
        };
    }

  //Function to emit to every room member
    emit(event, msg, sender) {
        this.users.forEach((user) => {
            if(user !== sender) user.socket.emit(event, msg);
        });
    }

    // Add method to broadcast member count
    updateMemberCount() {
        this.emit("serverdata", {
            count: this.users.length
        });
    }

    // Add method to handle votes
    handleVote(user, vote) {
        if (!this.poll.active || this.poll.voted.has(user.public.guid)) {
            return;
        }

        this.poll.voted.add(user.public.guid);
        if (vote) {
            this.poll.yes++;
        } else {
            this.poll.no++;
        }

        const total = this.poll.yes + this.poll.no;
        this.emit("pollupdate", {
            yes: (this.poll.yes / total) * 100,
            no: (this.poll.no / total) * 100,
            votecount: total
        });
    }

    // Add method to end poll
    endPoll() {
        this.poll = {
            active: false,
            name: "",
            yes: 0,
            no: 0,
            voted: new Set()
        };
    }

    // Add method to check if room is empty
    isEmpty() {
        return this.users.length === 0;
    }
}

// Function to get real IP address
function getRealIP(socket) {
    return socket.handshake.headers['x-real-ip'] || 
           socket.handshake.headers['x-forwarded-for'] || 
           socket.request.connection.remoteAddress;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    // Check for temporary bans
    const ip = getRealIP(socket);
    if(global.tempBans && global.tempBans.has(ip)) {
        socket.emit("ban", {
            reason: "Banned by Pope until server restart",
            end: new Date(Date.now() + 24*60*60*1000).toISOString()
        });
        socket.disconnect();
        return;
    }
    //First, verify this user fits the alt limit
    if(typeof userips[ip] == 'undefined') userips[ip] = 0;
    userips[ip]++;
    
    if(userips[ip] > config.altlimit){
        //If we have more than the altlimit, don't accept this connection and decrement the counter.
        userips[ip]--;
        socket.disconnect();
        return;
    }
    
    //Set up a new user on connection
    new user(socket);
});

//Command list
var commands = {
    name:(victim,param)=>{
        if (param == "" || param.length > config.namelimit) return;
        if(victim.statlocked) return; // Prevent if statlocked
        victim.public.name = param;
        victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public});
    },
    
    asshole:(victim,param)=>{
        victim.room.emit("asshole",{
            guid:victim.public.guid,
            target:param,
        });
    },
    
    color:(victim, param)=>{
        if(victim.statlocked) return;
        
        if(param.startsWith('http')) {
            const url = new URL(param);
            if(!config.whitelisted_image_hosts.includes(url.hostname)) {
                param = colors[Math.floor(Math.random() * colors.length)];
            }
        } else if(!colors.includes(param.toLowerCase())) {
            param = colors[Math.floor(Math.random() * colors.length)];
        }
        
        victim.public.color = param;
        victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public});
    },
    
    pitch:(victim, param)=>{
        param = parseInt(param);
        if(isNaN(param)) return;
        victim.public.pitch = param;
        victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public});
    },

    speed:(victim, param)=>{
        param = parseInt(param);
        if(isNaN(param) || param>400) return;
        victim.public.speed = param;
        victim.room.emit("update",{guid:victim.public.guid,userPublic:victim.public});
    },
    
    godmode:(victim, param)=>{
        if(hashPassword(param) === config.godword) {
            victim.level = 2;
            victim.socket.emit("authlv", {level: victim.level});
        }
    },

    kingmode:(victim, param)=>{
        if(!param) return;
        if(hashPassword(param) === config.kingword) {
            victim.level = KING_LEVEL;
            victim.socket.emit("authlv", {level: victim.level});
        }
    },

    pope:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        victim.public.color = "pope";
        victim.public.tagged = true;
        victim.public.tag = "Pope";
        victim.room.emit("update", {guid:victim.public.guid, userPublic:victim.public});
    },

    king:(victim, param)=>{
        if(victim.level < KING_LEVEL) return; // Must be King or higher
        victim.public.color = "king";
        victim.public.tagged = true;
        victim.public.tag = "King";
        victim.room.emit("update", {guid:victim.public.guid, userPublic:victim.public});
    },

    hail:(victim, param)=>{
        victim.room.emit("hail", {
            guid: victim.public.guid,
            user: param
        });
    },

    youtube:(victim, param)=>{
        victim.room.emit("youtube",{guid:victim.public.guid, vid:param.replace(/"/g, "&quot;")});
    },

    joke:(victim, param)=>{
        victim.room.emit("joke", {guid:victim.public.guid, rng:Math.random()});
    },
    
    fact:(victim, param)=>{
        victim.room.emit("fact", {guid:victim.public.guid, rng:Math.random()});
    },
    
    backflip:(victim, param)=>{
        victim.room.emit("backflip", {guid:victim.public.guid, swag:(param.toLowerCase() == "swag")});
    },
    
    owo:(victim, param)=>{
        victim.room.emit("owo",{
            guid:victim.public.guid,
            target:param,
        });
    },

    triggered:(victim, param)=>{
        victim.room.emit("triggered", {guid:victim.public.guid});
    },

    linux:(victim, param)=>{
        victim.room.emit("linux", {guid:victim.public.guid});
    },

    background:(victim, param)=>{
        victim.room.emit("background", {bg:param});
    },

    dm:(victim, param)=>{
        // Add DM functionality
        victim.room.emit("dm", {from:victim.public.guid, msg:param});
    },

    quote:(victim, param)=>{
        // Add quote functionality
        victim.room.emit("quote", {from:victim.public.guid, msg:param});
    },

    rabbify:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        let [targetId, duration] = param.split(" ");
        let target = victim.room.users.find(u => u.public.guid == targetId);
        if(!target) return;
        duration = parseInt(duration);
        if(isNaN(duration)) return;
        
        target.level = 0.5; // Rabbi level
        target.public.color = "rabbi";
        target.public.tagged = true;
        target.public.tag = "Rabbi";

        // Add IP to rabbi list
        const ip = target.socket.request.connection.remoteAddress;
        rabbiIPs.add(ip);
        saveRabbis();

        target.socket.emit("authlv", {level: target.level});
        victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
        target.socket.emit("rabbi", duration * 60);

        // Set timeout to remove rabbi status
        setTimeout(() => {
            rabbiIPs.delete(ip);
            saveRabbis();
            if(target.socket.connected) {
                target.level = 0;
                target.public.color = colors[Math.floor(Math.random()*colors.length)];
                target.public.tagged = false;
                target.public.tag = "";
                target.socket.emit("authlv", {level: target.level});
                victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
            }
        }, duration * 60 * 1000);
    },

    rabbi:(victim, param)=>{
        if(victim.level < 0.5) return; // Must be Rabbi or higher
        victim.public.color = "rabbi";
        victim.room.emit("update", {guid:victim.public.guid, userPublic:victim.public});
    },

    tag:(victim, param)=>{
        if(victim.level < 0.5) return; // Must be Rabbi or higher
        victim.public.tag = param;
        victim.public.tagged = true;
        victim.room.emit("update", {guid:victim.public.guid, userPublic:victim.public});
    },

    tagsom:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        let [targetId, tag] = param.split(" ");
        let target = victim.room.users.find(u => u.public.guid == targetId);
        if(!target) return;
        target.public.tag = tag;
        target.public.tagged = true;
        victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    bless:(victim, param)=>{
        if(victim.level < KING_LEVEL) return; // Must be King or higher
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;

        // Don't downgrade higher level users
        if(target.level >= KING_LEVEL) return;
        
        target.level = BLESSED_LEVEL;
        target.public.tagged = true;
        target.public.tag = "Blessed";
        target.public.color = "bless";
        target.socket.emit("authlv", {level: target.level});
        victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    jewify:(victim, param)=>{
        if(victim.level < KING_LEVEL) return; // Must be King or higher
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        
        target.public.color = "jew";
        target.public.tagged = true;
        target.public.tag = "Jew";
        victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    statcustom:(victim, param)=>{
        if(victim.level < KING_LEVEL) return; // Must be King or higher
        let [targetId, name, color] = param.split(" ");
        let target = victim.room.users.find(u => u.public.guid == targetId);
        if(!target) return;
        if(name) target.public.name = name;
        if(color) target.public.color = color;
        victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    statlock:(victim, param)=>{
        if(victim.level < KING_LEVEL) return; // Must be King or higher
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        
        target.statlocked = !target.statlocked;
        victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    // Pope-only commands (level 2)
    smute:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        target.muted = !target.muted;
        target.socket.emit("muted", {muted: target.muted}); // Send mute status to client
        if(target.muted) {
            target.public.name += " (muted)";
        } else {
            target.public.name = target.public.name.replace(" (muted)", "");
        }
        victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    floyd:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        target.socket.emit("nuke");
    },

    deporn:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;

        // Add the crosscolor to blacklist
        if(target.public.color.startsWith('http')) {
            blacklist.push(target.public.color);
            // Save blacklist to file
            fs.writeFileSync("./config/blacklist.txt", blacklist.join("\n"));
        }

        // Set humiliating properties
        target.public.name = "I love men";
        target.public.color = "jew";
        target.public.tagged = true;
        target.public.tag = "ME LOVE MEN!";

        // Update the user
        victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    kick:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        target.socket.emit("kick", {reason: "Kicked by an admin"});
        target.socket.disconnect();
    },

    ip:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;

        // Add IP to their name
        target.public.name = `${target.public.name} (IP: ${target.ip})`;
        
        // Update everyone about the name change
        victim.room.emit("update", {
            guid: target.public.guid,
            userPublic: target.public
        });

        // Announce the IP leak in chat
        victim.room.emit("talk", {
            guid: victim.guid,
            text: `${target.public.name}'s IP is ${target.ip}`
        });
    },

    ipmute:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        
        // Initialize ipMuted if it doesn't exist
        if(!global.ipMuted) global.ipMuted = new Set();
        
        // Toggle IP mute status
        if(global.ipMuted.has(target.ip)) {
            global.ipMuted.delete(target.ip);
            // Remove IP from name
            target.public.name = target.public.name.replace(/ \(IP: [^)]+\)$/, '');
        } else {
            global.ipMuted.add(target.ip);
            // Add IP to name
            target.public.name = `${target.public.name} (IP: ${target.ip})`;
        }
        
        // Update everyone about the name change
        victim.room.emit("update", {
            guid: target.public.guid,
            userPublic: target.public
        });
    },

    // Add new commands for announcements and polls
    announce:(victim, param) => {
        if (victim.level < BLESSED_LEVEL) return; // Must be Blessed or higher
        victim.room.emit("announcement", {
            from: victim.public.name,
            msg: param
        });
    },

    poll:(victim, param) => {
        if (victim.level < BLESSED_LEVEL) return; // Must be Blessed or higher
        
        if (victim.room.poll.active) {
            victim.socket.emit("talk", {
                guid: victim.public.guid,
                text: "A poll is already active!"
            });
            return;
        }

        victim.room.poll = {
            active: true,
            name: param,
            yes: 0,
            no: 0,
            voted: new Set()
        };

        victim.room.emit("pollshow", param);
        victim.room.emit("pollupdate", {
            yes: 0,
            no: 0,
            votecount: 0
        });

        // Auto-end poll after 5 minutes
        setTimeout(() => {
            victim.room.endPoll();
        }, 5 * 60 * 1000);
    },

    fullmute:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        
        target.muted = !target.muted;
        if(target.muted) {
            target.public.name += " (muted)";
        } else {
            target.public.name = target.public.name.replace(" (muted)", "");
        }
        target.socket.emit("muted", {muted: target.muted}); // Send mute status to client
        victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    ban:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;

        // Add IP to temporary ban list
        if(!global.tempBans) global.tempBans = new Set();
        global.tempBans.add(target.socket.request.connection.remoteAddress);

        // Show ban page
        target.socket.emit("ban", {});
        target.socket.disconnect();
    },

    voicemute:(victim, param) => {
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        
        target.voiceMuted = !target.voiceMuted;
        target.public.voiceMuted = target.voiceMuted;
        
        // If muting, remove speaking status if active
        if(target.voiceMuted && target.public.speaking) {
            target.public.name = target.originalName;
            target.public.speaking = false;
        }
        
        if(target.voiceMuted) {
            target.public.name += " (voice muted)";
        } else {
            target.public.name = target.public.name.replace(" (voice muted)", "");
        }
        
        target.socket.emit("voiceMuted", {muted: target.voiceMuted});
        victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },
};

// Start server
http.listen(config.port || 3000, () => {
    rooms["default"] = new room("default");
    console.log("running at http://bonzi.localhost:" + (config.port || 3000));
});

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}
