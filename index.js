const express = require("express");
const app = express();
const http = require("http").Server(app);
const io = require("socket.io")(http, {
    allowEIO3: true
});
const fs = require("fs");
const crypto = require('crypto');
const argon2 = require('argon2');

// Global error handler
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Emit error to all connected clients
    io.emit('globalError', {
        message: `REPORT THIS TO JOEL OR THE OTHER OWNER! ${error.message}`,
        stack: error.stack
    });
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Emit error to all connected clients
    io.emit('globalError', {
        message: `REPORT THIS TO JOEL OR THE OTHER OWNER! ${reason}`,
        stack: reason.stack || 'No stack trace available'
    });
});

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
const KING_LEVEL = 2;
const ROOMOWNER_LEVEL = 0.5;
const BLESSED_LEVEL = 1;
const POPE_LEVEL = 3;
const DEFAULT_LEVEL = 0;

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

// User class
class user {
    constructor(socket) {
        this.socket = socket;
        this.ip = getRealIP(socket);
        
        // Initialize user properties
        this.room = null;
        this.guid = this.newGuid();
        this.public = {
            guid: this.guid,
            color: this.getRandomColor(),
            name: "Anonymous",
            tag: null,
            tagged: false,
            typing: "",
            coins: 0,
            speaking: false,
            hasLock: false,
            hasBoltCutters: false,
            hasSelfDefenseGun: false,
            hasRingDoorbell: false,
            crosscolorsEnabled: true
        };
        this.loggedin = false;
        this.level = DEFAULT_LEVEL;
        this.slowed = false;
        this.sanitize = true;
        this.muted = false;
        this.statlocked = false;
        this.voiceMuted = false;
        this.originalName = "";
        this.stealSuccessRate = 0.5; // Default steal success rate
        this.public.isHomeless = false;
        this.sanitizeEnabled = true; // Personal sanitization setting

        // Add typing indicator with room check and throttling
        this.lastTypingUpdate = 0;
        this.socket.on("typing", (data) => {
            if(!this.room || !this.loggedin) return;
            if(typeof data !== "object") return;
            
            // Throttle typing updates to reduce lag
            const now = Date.now();
            if (now - this.lastTypingUpdate < 500) return; // Max 2 updates per second
            this.lastTypingUpdate = now;
            
            this.public.typing = data.state === 1 ? " (typing)" : data.state === 2 ? " (commanding)" : "";
            if(this.room) this.room.emitWithCrosscolorFilter("update", { guid: this.public.guid, userPublic: this.public }, this);
        });

        // Add speaking status handler with room check
        this.socket.on("speaking", (speaking) => {
            if(!this.room || !this.loggedin) return;
            if(this.voiceMuted) return;
            
            if(speaking) {
                if(!this.public.speaking) {
                    this.originalName = this.public.name;
                    this.public.name += " (speaking)";
                }
            } else {
                if(this.public.speaking) {
                    this.public.name = this.originalName;
                }
            }
            
            this.public.speaking = speaking;
            if(this.room) {
                this.room.emit("update", {guid: this.public.guid, userPublic: this.public});
            }
        });

        // Add voice chat handler with room check
        this.socket.on("voice", (data) => {
            if(!this.room || !this.loggedin) return;
            if(this.voiceMuted) return;
            
            this.room.emit("voice", {
                guid: this.public.guid,
                data: data
            }, this);
        });

        // Add login handler with proper room initialization
        this.socket.on("login", (logdata) => {
            if(typeof logdata !== "object" || typeof logdata.name !== "string" || typeof logdata.room !== "string") return;
            
            if (logdata.name == undefined || logdata.room == undefined) {
                logdata = { room: "default", name: "Anonymous" };
            }
            
            if(this.loggedin) return; // Prevent multiple logins
            
            try {
                // Set up user data
                this.loggedin = true;
                this.public.name = logdata.name || "Anonymous";
                
                // Check for rabbi cookie - simple expiry check
                if(logdata.rabbiExpiry) {
                    if(parseInt(logdata.rabbiExpiry) > Date.now()) {
                        this.level = 0.5;
                        this.public.color = "rabbi";
                        this.public.tagged = true;
                        this.public.tag = "Rabbi";
                    }
                }
                
                // Handle room setup
                let roomname = logdata.room || "default";
                if(roomname == "") roomname = "default";
                
                // Create room if it doesn't exist
                if(!rooms[roomname]) {
                    rooms[roomname] = new room(roomname);
                    this.level = ROOMOWNER_LEVEL;
                    this.public.tagged = true;
                    this.public.tag = "Room Owner";
                    this.public.color = "king";
                }
                
                // Join room
                this.room = rooms[roomname];
                if(this.room) {
                    this.room.users.push(this);
                    this.room.usersPublic[this.public.guid] = this.public;
                    
                    // Update room
                    this.socket.emit("updateAll", { usersPublic: this.room.usersPublic });
                    this.room.emit("update", { guid: this.public.guid, userPublic: this.public }, this);
                    this.room.updateMemberCount();
                }
                
                // Send room info
                this.socket.emit("room", {
                    room: roomname,
                    isOwner: this.level >= KING_LEVEL,
                    isPublic: roomname === "default"
                });
                
                // Send auth level
                this.socket.emit("authlv", {level: this.level});
                
            } catch(err) {
                console.error("Login error:", err);
                this.socket.emit("login_error", "Failed to join room");
                this.loggedin = false;
                this.room = null;
            }
        });

        // Handle disconnection with room cleanup
        this.socket.on("disconnect", () => {
            if(!this.loggedin || !this.room) return;
            
            try {
                // Clean up room references
                if(this.room.usersPublic[this.public.guid]) {
                    delete this.room.usersPublic[this.public.guid];
                }
                
                const userIndex = this.room.users.indexOf(this);
                if(userIndex > -1) {
                    this.room.users.splice(userIndex, 1);
                }
                
                // Notify others and update count
                this.room.emit("leave", { guid: this.public.guid });
                this.room.updateMemberCount();
                
                // Clean up empty rooms except default
                if(this.room.isEmpty() && this.room.name !== "default") {
                    delete rooms[this.room.name];
                }
            } catch(err) {
                console.error("Disconnect cleanup error:", err);
            }
        });

        //talk
        this.socket.on("talk", (msg) => {
            if(typeof msg !== "object" || typeof msg.text !== "string") return;
            if(this.muted) return;
            
            if(this.sanitize) msg.text = msg.text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            if(filtertext(msg.text) && this.sanitize) msg.text = "RAPED AND ABUSED";
            
            if(!this.slowed) {
                this.room.emit("talk", { guid: this.public.guid, text: msg.text });
                this.slowed = true;
                setTimeout(()=>{
                    this.slowed = false;
                }, config.slowmode);
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
            if(!data.id) return; // Must have target ID
            let target = this.room.users.find(u => u.public.guid == data.id);
            if(!target) return;
            
            // Check if target is statlocked
            if(target.statlocked) return;
            
            // Update color if provided
            if(data.color) {
                target.public.color = data.color;
            }
            
            // Update name if provided  
            if(data.name) {
                target.public.name = data.name;
            }
            
            // Emit update to room
            this.room.emit("update", {guid: target.public.guid, userPublic: target.public});
        });

        // Remove old useredit handlers
        this.socket.removeAllListeners("useredit");

        // COMMAND HANDLER
        this.socket.on("command", async (data) => {
            if (typeof data !== "object") return;
            
            let command = data.list[0];
            let args = data.list.slice(1);
            
            switch(command) {
                case "ban":
                    if (this.level < POPE_LEVEL) return;
                    let target = this.room.users.find(u => u.guid === args[0]);
                    if (!target) return;
                    
                    // Add IP to tempBans
                    if (!global.tempBans) global.tempBans = new Set();
                    global.tempBans.add(target.ip);
                    
                    // Disconnect the user
                    target.socket.emit("ban", {
                        reason: "Banned by Pope until server restart",
                        end: new Date(Date.now() + 24*60*60*1000).toISOString()
                    });
                    target.socket.disconnect();
                    break;
                    
                default:
                    //parse and check
                    if(args[0] == undefined) return;
                    var comd = args[0];
                    var param = "";
                    if(args[1] == undefined) param = [""];
                    else{
                    param=args;
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
            }
        });

        // Add coin handlers
        this.socket.on("stealCoins", (targetId) => {
            if (!this.room) return;
            
            const target = this.room.users.find(u => u.public.guid === targetId);
            if (!target) return;

            // Check if target has self defense gun
            if (target.public.hasSelfDefenseGun) {
                // Thief loses everything
                this.coins = -500;
                this.public.coins = this.coins;
                this.public.hasLock = false;
                this.public.hasRingDoorbell = false;
                this.public.hasSelfDefenseGun = false;
                this.public.hasVetoPower = false;
                this.public.hasBroom = false;
                this.public.tagged = true;
                this.public.tag = "homeless";
                
                // Lower steal success chance
                this.stealSuccessRate = 0.1; // 10% chance instead of normal
                
                // Disable work and gamble
                this.public.isHomeless = true;
                
                this.socket.emit("coinSteal", {
                    success: false,
                    reason: "selfdefense",
                    thief: this.public.name
                });
                
                // Update both users
                if(this.room) {
                    this.room.emit("update", {
                        guid: this.public.guid,
                        userPublic: this.public
                    });
                    this.room.emit("update", {
                        guid: target.public.guid,
                        userPublic: target.public
                    });
                }
                return;
            }
            
            // Check if target has a lock
            if(target.public.hasLock) {
                // Check if thief has bolt cutters
                if(this.public.hasBoltCutters) {
                    // Bolt cutters break the lock
                    target.public.hasLock = false;
                    this.public.hasBoltCutters = false; // Bolt cutters are consumed
                    
                    let stolenAmount = Math.floor(target.coins * 0.5);
                    target.coins -= stolenAmount;
                    this.coins += stolenAmount;
                    
                    target.public.coins = target.coins;
                    this.public.coins = this.coins;
                    
                    this.room.emit("update", {guid: target.public.guid, userPublic: target.public});
                    this.room.emit("update", {guid: this.public.guid, userPublic: this.public});
                    
                    this.socket.emit("alert", `Used bolt cutters to break ${target.public.name}'s lock and stole ${stolenAmount} coins!`);
                    target.socket.emit("alert", `${this.public.name} used bolt cutters to break your lock and stole ${stolenAmount} coins!`);
                    return;
                } else {
                    // Lock protects the target
                    this.socket.emit("alert", `${target.public.name}'s lock protected them from theft!`);
                    
                    // Ring Doorbell gives extra info
                    if (target.public.hasRingDoorbell) {
                        target.socket.emit("alert", `${this.public.name} (${this.coins} coins) tried to steal from you but your lock protected you! [Ring Doorbell Alert]`);
                    } else {
                        target.socket.emit("alert", `${this.public.name} tried to steal from you but your lock protected you!`);
                    }
                    return;
                }
            }

            // Normal steal attempt (no lock or lock was broken)
            // 50% chance of success
            if(Math.random() < this.stealSuccessRate) {
                // Success - steal 50% of their coins
                let stolenAmount = Math.floor(target.coins * 0.5);
                target.coins -= stolenAmount;
                this.coins += stolenAmount;
                
                // Update both users' public coin amounts
                target.public.coins = target.coins;
                this.public.coins = this.coins;
                
                this.room.emit("update", {guid: target.public.guid, userPublic: target.public});
                this.room.emit("update", {guid: this.public.guid, userPublic: this.public});
                
                this.socket.emit("alert", `Successfully stole ${stolenAmount} coins from ${target.public.name}!`);
                target.socket.emit("alert", `${this.public.name} stole ${stolenAmount} coins from you!`);
            } else {
                // Fail - get tagged, turned into jew, and lose 20 coins
                this.public.color = "jew";
                this.public.tagged = true;
                this.public.tag = "STEAL FAIL";
                
                // Penalty: lose 20 coins
                const penalty = Math.min(this.coins, 20);
                this.coins -= penalty;
                this.public.coins = this.coins;
                
                this.room.emit("update", {guid: this.public.guid, userPublic: this.public});
                this.socket.emit("alert", `Steal failed! You've been caught and lost ${penalty} coins!`);
                
                // Ring Doorbell gives extra info to victim
                if (target.public.hasRingDoorbell) {
                    target.socket.emit("alert", `${this.public.name} (${this.coins} coins) tried to steal from you but failed! They lost ${penalty} coins as penalty. [Ring Doorbell Alert]`);
                } else {
                    target.socket.emit("alert", `${this.public.name} tried to steal from you but failed!`);
                }
            }
        });

        this.socket.on("gambleCoins", (amount) => {
            if (this.public.isHomeless) {
                this.socket.emit("alert", "You are homeless and cannot gamble!");
                return;
            }
            amount = parseInt(amount);
            if(isNaN(amount) || amount <= 0 || amount > this.coins) {
                this.socket.emit("alert", "Invalid gambling amount!");
                return;
            }

            // 45% chance to win (house edge)
            if(Math.random() < 0.45) {
                this.coins += amount;
                this.socket.emit("alert", `You won ${amount} coins!`);
            } else {
                this.coins -= amount;
                this.socket.emit("alert", `You lost ${amount} coins!`);
            }
            
            this.public.coins = this.coins;
            this.room.emit("update", {guid: this.public.guid, userPublic: this.public});
        });

        this.socket.on("work", () => {
            if (this.public.isHomeless) {
                this.socket.emit("alert", "You are homeless and cannot work!");
                return;
            }
            const now = Date.now();
            const cooldown = 5 * 60 * 1000; // 5 minutes
            
            if(now - this.lastWork < cooldown) {
                this.socket.emit("alert", `You must wait ${Math.ceil((cooldown - (now - this.lastWork)) / 1000)} seconds before working again!`);
                return;
            }

            const earnedCoins = Math.floor(Math.random() * 30) + 20; // 20-50 coins
            this.coins += earnedCoins;
            this.public.coins = this.coins;
            this.lastWork = now;
            
            this.room.emit("update", {guid: this.public.guid, userPublic: this.public});
            this.socket.emit("alert", `You earned ${earnedCoins} coins from working!`);
        });

        // Shop system
        this.socket.on("getShop", () => {
            const shopItems = [
                { id: "lock", name: "Lock", price: 25, description: "Prevents coin theft" },
                { id: "boltcutters", name: "Bolt Cutters", price: 75, description: "Cut through locks" },
                { id: "ringdoorbell", name: "Ring Doorbell", price: 150, description: "Know who tries to steal from you" },
                { id: "vetopower", name: "Veto Power", price: 200, description: "Jewify others + set your own coins (1-200)" },
                { id: "broom", name: "Magical Broom", price: 999, description: "I bought a broom tag + Endgame CMDs" },
                { id: "selfdefensegun", name: "Self Defense Gun", price: 300, description: "Defend against thieves" }
            ];
            
            this.socket.emit("shopMenu", {
                balance: this.coins,
                items: shopItems
            });
        });

        this.socket.on("buyItem", (itemId) => {
            console.log(`[BUY] User ${this.public.name} (${this.guid}) attempting to buy: ${itemId}`);
            console.log(`[BUY] User has ${this.coins} coins`);
            
            if(!itemId || typeof itemId !== "string") {
                this.socket.emit("alert", "Invalid item ID");
                return;
            }

            let item, price;
            switch(itemId) {
                case "lock":
                    item = "Lock";
                    price = 25;
                    break;
                case "boltcutters":
                    item = "Bolt Cutters";
                    price = 75;
                    break;
                case "ringdoorbell":
                    item = "Ring Doorbell";
                    price = 150;
                    break;
                case "vetopower":
                    item = "Veto Power";
                    price = 200;
                    break;
                case "broom":
                    item = "Magical Broom";
                    price = 999;
                    break;
                case "selfdefensegun":
                    if (this.coins < 300) {
                        this.socket.emit("purchaseFailed", { reason: "Not enough coins" });
                        return;
                    }
                    
                    this.coins -= 300;
                    this.public.coins = this.coins;
                    this.public.hasSelfDefenseGun = true;
                    
                    this.socket.emit("purchaseSuccess", { 
                        item: "Self Defense Gun",
                        message: "You can now defend against thieves!"
                    });
                    
                    if(this.room) {
                        this.room.emit("update", {
                            guid: this.public.guid,
                            userPublic: this.public
                        });
                    }
                    return;
                default:
                    console.log(`[BUY] Unknown item: ${itemId}`);
                    this.socket.emit("alert", "Item not found");
                    return;
            }

            console.log(`[BUY] Item: ${item}, Price: ${price}, User coins: ${this.coins}`);

            // Check if user has enough coins
            if(this.coins < price) {
                console.log(`[BUY] Insufficient coins: need ${price}, have ${this.coins}`);
                this.socket.emit("alert", `You need ${price} coins but only have ${this.coins} coins!`);
                return;
            }

            // User has enough coins - proceed with purchase
            console.log(`[BUY] Purchase approved! Deducting ${price} coins`);
            this.coins -= price;
            this.public.coins = this.coins;

            // Apply item effects
            let message = "";
            switch(itemId) {
                case "lock":
                    this.public.hasLock = true;
                    message = "You are now protected from theft!";
                    break;
                case "boltcutters":
                    this.public.hasBoltCutters = true;
                    message = "You can now cut through locks!";
                    break;
                case "ringdoorbell":
                    this.public.hasRingDoorbell = true;
                    message = "You can now see who tries to steal from you!";
                    break;
                case "vetopower":
                    this.public.hasVetoPower = true;
                    this.public.tag = "VETO POWER";
                    this.public.tagged = true;
                    message = "You now have Veto Power! You can jewify others and set your own coins (1-200)!";
                    break;
                case "broom":
                    this.public.hasBroom = true;
                    this.public.tag = "I bought a broom";
                    this.public.tagged = true;
                    message = "You now have the broom tag and Endgame CMDs!";
                    break;
            }

            // Update user data and notify success
            console.log(`[BUY] Purchase complete! User now has ${this.coins} coins`);
            this.room.emit("update", {guid: this.public.guid, userPublic: this.public});
            this.socket.emit("alert", `Successfully purchased ${item}! ${message}`);
        });

        // Search system - risky adventure
        this.socket.on("search", (location) => {
            if(!location || typeof location !== "string" || location.length > 100) {
                this.socket.emit("alert", "Invalid search location!");
                return;
            }

            // Random outcomes with different probabilities
            const outcomes = [
                // Good outcomes (30%)
                { type: "coins", amount: 50, chance: 0.10, message: `You found a treasure chest in the ${location} and gained 50 coins!` },
                { type: "coins", amount: 100, chance: 0.05, message: `You discovered a hidden vault in the ${location} and found 100 coins!` },
                { type: "coins", amount: 25, chance: 0.15, message: `You found some loose change in the ${location} and gained 25 coins!` },
                
                // Neutral outcomes (20%)
                { type: "nothing", chance: 0.20, message: `You searched the ${location} thoroughly but found nothing of value.` },
                
                // Bad outcomes (50%)
                { type: "lose_coins", amount: 30, chance: 0.15, message: `You got mugged while exploring the ${location} and lost 30 coins!` },
                { type: "lose_coins", amount: 50, chance: 0.10, message: `You fell into a trap in the ${location} and lost 50 coins!` },
                { type: "lose_coins", amount: 20, chance: 0.15, message: `You had to pay a bribe to escape the ${location} and lost 20 coins!` },
                { type: "identity_loss", chance: 0.10, message: `You got lost in the ${location} and lost your identity! All coins and items gone!` }
            ];

            // Pick random outcome based on chances
            let random = Math.random();
            let cumulative = 0;
            let selectedOutcome = null;

            for(let outcome of outcomes) {
                cumulative += outcome.chance;
                if(random <= cumulative) {
                    selectedOutcome = outcome;
                    break;
                }
            }

            // Apply the outcome
            switch(selectedOutcome.type) {
                case "coins":
                    this.coins += selectedOutcome.amount;
                    this.public.coins = this.coins;
                    this.socket.emit("alert", selectedOutcome.message);
                    break;
                    
                case "lose_coins":
                    const lostAmount = Math.min(this.coins, selectedOutcome.amount);
                    this.coins -= lostAmount;
                    this.public.coins = this.coins;
                    this.socket.emit("alert", selectedOutcome.message.replace(selectedOutcome.amount, lostAmount));
                    break;
                    
                case "identity_loss":
                    // Reset everything - lose identity
                    this.coins = 0;
                    this.public.coins = 0;
                    this.public.hasLock = false;
                    this.public.hasBoltCutters = false;
                    this.public.hasBroom = false;
                    this.public.tag = "LOST SOUL";
                    this.public.tagged = true;
                    this.public.color = "black";
                    this.socket.emit("alert", selectedOutcome.message);
                    break;
                    
                case "nothing":
                default:
                    this.socket.emit("alert", selectedOutcome.message);
                    break;
            }

            // Update user data
            this.room.emit("update", {guid: this.public.guid, userPublic: this.public});
        });

        // Voice chat handler
        this.socket.on("voiceChat", (data) => {
            if (!data || !data.audio) return;
            if (!this.room || !this.room.users) return; // Check if room exists
            
            // Add speaking indicator
            if(!this.public.speaking) {
                this.originalName = this.public.name;
                this.public.name += " (speaking)";
                this.public.speaking = true;
                this.room.emit("update", {guid: this.public.guid, userPublic: this.public});
            }
            
            // Broadcast voice to all users in room except sender
            this.room.users.forEach(user => {
                if (user !== this && user.socket && user.socket.connected) {
                    user.socket.emit("voiceChat", {
                        from: this.public.guid,
                        fromName: this.public.name,
                        audio: data.audio,
                        duration: data.duration || 3000 // Default 3 seconds
                    });
                }
            });
            
            // Remove speaking indicator after audio duration
            setTimeout(() => {
                if(this.public.speaking) {
                    this.public.name = this.originalName;
                    this.public.speaking = false;
                    if(this.room) {
                        this.room.emit("update", {guid: this.public.guid, userPublic: this.public});
                    }
                }
            }, data.duration || 3000);
        });

        // Donate coins
        this.socket.on("donateCoins", (data) => {
            if(!data || !data.target || !data.amount) {
                this.socket.emit("alert", "Invalid donation data!");
                return;
            }

            let amount = parseInt(data.amount);
            if(isNaN(amount) || amount <= 0 || amount > this.coins) {
                this.socket.emit("alert", "Invalid donation amount!");
                return;
            }

            let target = this.room.users.find(u => u.public.guid === data.target);
            if(!target) {
                this.socket.emit("alert", "Target user not found!");
                return;
            }

            if(target.guid === this.guid) {
                this.socket.emit("alert", "You can't donate to yourself!");
                return;
            }

            // Transfer coins
            this.coins -= amount;
            target.coins += amount;
            
            this.public.coins = this.coins;
            target.public.coins = target.coins;
            
            this.room.emit("update", {guid: this.public.guid, userPublic: this.public});
            this.room.emit("update", {guid: target.public.guid, userPublic: target.public});
            
            this.socket.emit("alert", `You donated ${amount} coins to ${target.public.name}!`);
            target.socket.emit("alert", `${this.public.name} donated ${amount} coins to you!`);
        });
    }

    getRandomColor() {
        // Filter out privileged colors from the selection pool
        const availableColors = colors.filter(color => !PRIVILEGED_COLORS.includes(color));
        return availableColors[Math.floor(Math.random() * availableColors.length)];
    }

    newGuid() {
        return guidGen();
    }

    // ... rest of the class methods ...
}

// Room class with error handling
class room {
    constructor(name) {
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

    emit(event, msg, sender) {
        if(!this.users) return;
        
        try {
            this.users.forEach((user) => {
                if(user && user.socket && user !== sender) {
                    user.socket.emit(event, msg);
                }
            });
        } catch(err) {
            console.error("Room emit error:", err);
        }
    }

    emitWithCrosscolorFilter(event, msg, targetUser) {
        if(!this.users) return;
        
        try {
            this.users.forEach((user) => {
                if(user && user.socket && user !== targetUser) {
                    let filteredMsg = { ...msg };
                    
                    // If this is an update event and the target has a crosscolor
                    if (event === "update" && targetUser && targetUser.public.realColor && targetUser.public.realColor.startsWith('http')) {
                        // Check if the receiving user has crosscolors disabled
                        if (!user.public.crosscolorsEnabled) {
                            // Hide the crosscolor from users who disabled them
                            filteredMsg = { ...msg };
                            filteredMsg.userPublic = { ...msg.userPublic };
                            filteredMsg.userPublic.color = "purple"; // Default color for users with crosscolors disabled
                        }
                    }
                    
                    user.socket.emit(event, filteredMsg);
                }
            });
            
            // Send the real color to the target user themselves
            if(targetUser && targetUser.socket) {
                targetUser.socket.emit(event, msg);
            }
        } catch(err) {
            console.error("Room emitWithCrosscolorFilter error:", err);
        }
    }

    updateMemberCount() {
        if(!this.users) return;
        this.emit("serverdata", { count: this.users.length });
    }

    isEmpty() {
        return !this.users || this.users.length === 0;
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
}

// Function to get real IP address - prioritize x-real-ip
function getRealIP(socket) {
    return socket.handshake.headers['x-real-ip'] || 
           socket.handshake.headers['x-forwarded-for'] || 
           socket.request.connection.remoteAddress;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    // Check for temporary bans using real IP
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
        if(victim.room) victim.room.emitWithCrosscolorFilter("update",{guid:victim.public.guid,userPublic:victim.public}, victim);
    },
    
    asshole:(victim,param)=>{
        if(victim.room) {
            victim.room.emit("asshole",{
                guid:victim.public.guid,
                target:param,
            });
        }
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
        victim.public.realColor = param; // Store the real color (including crosscolors)
        if(victim.room) victim.room.emitWithCrosscolorFilter("update", {guid:victim.public.guid,userPublic:victim.public}, victim);
    },
    
    pitch:(victim, param)=>{
        param = parseInt(param);
        if(isNaN(param)) return;
        victim.public.pitch = param;
        if(victim.room) victim.room.emitWithCrosscolorFilter("update",{guid:victim.public.guid,userPublic:victim.public}, victim);
    },

    speed:(victim, param)=>{
        param = parseInt(param);
        if(isNaN(param) || param>400) return;
        victim.public.speed = param;
        if(victim.room) victim.room.emitWithCrosscolorFilter("update",{guid:victim.public.guid,userPublic:victim.public}, victim);
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
        if(victim.room) victim.room.emit("update", {guid:victim.public.guid, userPublic:victim.public});
    },

    king:(victim, param)=>{
        if(victim.level < KING_LEVEL) return; // Must be King or higher
        victim.public.color = "king";
        victim.public.tagged = true;
        victim.public.tag = "King";
        if(victim.room) victim.room.emit("update", {guid:victim.public.guid, userPublic:victim.public});
    },

    hail:(victim, param)=>{
        if(victim.room) {
            victim.room.emit("hail", {
                guid: victim.public.guid,
                user: param
            });
        }
    },

    youtube:(victim, param)=>{
        if(victim.room) victim.room.emit("youtube",{guid:victim.public.guid, vid:param.replace(/"/g, "&quot;")});
    },

    joke:(victim, param)=>{
        if(victim.room) victim.room.emit("joke", {guid:victim.public.guid, rng:Math.random()});
    },
    
    fact:(victim, param)=>{
        if(victim.room) victim.room.emit("fact", {guid:victim.public.guid, rng:Math.random()});
    },
    
    backflip:(victim, param)=>{
        if(victim.room) victim.room.emit("backflip", {guid:victim.public.guid, swag:(param.toLowerCase() == "swag")});
    },
    
    owo:(victim, param)=>{
        if(victim.room) victim.room.emit("owo",{
            guid:victim.public.guid,
            target:param,
        });
    },

    triggered:(victim, param)=>{
        if(victim.room) victim.room.emit("triggered", {guid:victim.public.guid});
    },

    linux:(victim, param)=>{
        if(victim.room) victim.room.emit("linux", {guid:victim.public.guid});
    },

    background:(victim, param)=>{
        if(victim.level < KING_LEVEL) return; // Must be King or higher
        if(victim.room) victim.room.emit("background", {bg:param});
    },

    // Endgame commands for broom owners and veto power holders
    jewify:(victim, param)=>{
        if(!victim.public.hasBroom && !victim.public.hasVetoPower) return; // Must have broom or veto power
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        
        target.public.color = "jew";
        target.public.realColor = "jew";
        target.public.tagged = true;
        target.public.tag = "JEWIFIED";
        if(victim.room) victim.room.emitWithCrosscolorFilter("update", {guid: target.public.guid, userPublic: target.public}, target);
    },

    bless:(victim, param)=>{
        if(!victim.public.hasBroom) return; // Must have broom
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        
        target.public.color = "blessed";
        target.public.tagged = true;
        target.public.tag = "BLESSED";
        if(victim.room) victim.room.emit("update", {guid: target.public.guid, userPublic: target.public});
    },

    setcoins:(victim, param)=>{
        if(!victim.public.hasBroom) return; // Must have broom
        let [targetId, amount] = param.split(" ");
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == targetId);
        if(!target) return;
        
        amount = parseInt(amount);
        if(isNaN(amount) || amount < 0) return;
        
        target.coins = amount;
        target.public.coins = amount;
        if(victim.room) victim.room.emitWithCrosscolorFilter("update", {guid: target.public.guid, userPublic: target.public}, target);
        victim.socket.emit("alert", `Set ${target.public.name}'s coins to ${amount}`);
    },

    mycoins:(victim, param)=>{
        if(!victim.public.hasVetoPower) return; // Must have veto power
        
        let amount = parseInt(param);
        if(isNaN(amount) || amount < 1 || amount > 200) {
            victim.socket.emit("alert", "You can only set your coins between 1 and 200!");
            return;
        }
        
        victim.coins = amount;
        victim.public.coins = amount;
        if(victim.room) victim.room.emitWithCrosscolorFilter("update", {guid: victim.public.guid, userPublic: victim.public}, victim);
        victim.socket.emit("alert", `Set your coins to ${amount}`);
    },

    toggle:(victim, param)=>{
        victim.public.crosscolorsEnabled = !victim.public.crosscolorsEnabled;
        victim.socket.emit("alert", `Crosscolors ${victim.public.crosscolorsEnabled ? 'enabled' : 'disabled'}`);
        
        // Refresh all users to apply the toggle
        if(victim.room) {
            victim.room.users.forEach(user => {
                victim.room.emitWithCrosscolorFilter("update", {guid: user.public.guid, userPublic: user.public}, user);
            });
        }
    },

    dm:(victim, param)=>{
        // Add DM functionality
        if(victim.room) victim.room.emit("dm", {from:victim.public.guid, msg:param});
    },

    quote:(victim, param)=>{
        // Add quote functionality
        if(victim.room) victim.room.emit("quote", {from:victim.public.guid, msg:param});
    },

    rabbify:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        let [targetId, duration] = param.split(" ");
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == targetId);
        if(!target) return;
        duration = parseInt(duration);
        if(isNaN(duration)) return;
        
        target.level = 0.5; // Rabbi level
        target.public.color = "rabbi";
        target.public.tagged = true;
        target.public.tag = "Rabbi";

        // Set rabbi cookie with just expiry timestamp
        const expiry = Date.now() + (duration * 60 * 1000);
        target.socket.emit("setRabbiCookie", {
            expiry: expiry,
            duration: duration * 60
        });

        target.socket.emit("authlv", {level: target.level});
        if(victim.room) victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
        target.socket.emit("rabbi", duration * 60);

        // Set timeout to remove rabbi status
        setTimeout(() => {
            if(target.socket.connected) {
                target.level = 0;
                target.public.color = colors[Math.floor(Math.random()*colors.length)];
                target.public.tagged = false;
                target.public.tag = "";
                target.socket.emit("authlv", {level: target.level});
                target.socket.emit("clearRabbiCookie");
                if(victim.room) victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
            }
        }, duration * 60 * 1000);
    },

    rabbi:(victim, param)=>{
        if(victim.level < 0.5) return; // Must be Rabbi or higher
        victim.public.color = "rabbi";
        if(victim.room) victim.room.emit("update", {guid:victim.public.guid, userPublic:victim.public});
    },

    tag:(victim, param)=>{
        if(victim.level < 0.5) return; // Must be Rabbi or higher
        victim.public.tag = param;
        victim.public.tagged = true;
        if(victim.room) victim.room.emit("update", {guid:victim.public.guid, userPublic:victim.public});
    },

    tagsom:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        let [targetId, tag] = param.split(" ");
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == targetId);
        if(!target) return;
        target.public.tag = tag;
        target.public.tagged = true;
        if(victim.room) victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    bless:(victim, param)=>{
        if(victim.level < KING_LEVEL) return; // Must be King or higher
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;

        // Don't downgrade higher level users
        if(target.level >= KING_LEVEL) return;
        
        target.level = BLESSED_LEVEL;
        target.public.tagged = true;
        target.public.tag = "Blessed";
        target.public.color = "bless";
        target.socket.emit("authlv", {level: target.level});
        if(victim.room) victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    jewify:(victim, param)=>{
        if(victim.level < KING_LEVEL) return; // Must be King or higher
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        
        target.public.color = "jew";
        target.public.tagged = true;
        target.public.tag = "Jew";
        if(victim.room) victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    statcustom:(victim, param)=>{
        if(victim.level < KING_LEVEL) return; // Must be King or higher
        let [targetId, name, color] = param.split(" ");
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == targetId);
        if(!target) return;
        if(name) target.public.name = name;
        if(color) target.public.color = color;
        if(victim.room) victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    statlock:(victim, param)=>{
        if(victim.level < KING_LEVEL) return; // Must be King or higher
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        
        target.statlocked = !target.statlocked;
        if(victim.room) victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    // Pope-only commands (level 2)
    smute:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        target.muted = !target.muted;
        
        // If muting, also interrupt any voice chat
        if(target.muted) {
            // Remove speaking status if active and restore original name
            if(target.public.speaking) {
                target.public.name = target.originalName || target.public.name.replace(" (speaking)", "");
                target.public.speaking = false;
            }
            target.public.name += " (muted)";
            // Notify all clients to interrupt voice chat
            victim.room.emit("voiceMuted", {
                guid: target.public.guid,
                muted: true,
                name: target.public.name
            });
        } else {
            target.public.name = target.public.name.replace(" (muted)", "");
        }
        
        target.socket.emit("muted", {muted: target.muted}); // Send mute status to client
        if(victim.room) victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    floyd:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        target.socket.emit("nuke");
    },

    deporn:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        if(!victim.room) return;
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
        if(victim.room) victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    kick:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        target.socket.emit("kick", {reason: "Kicked by an admin"});
        target.socket.disconnect();
    },

    // Add new commands for announcements and polls
    announce:(victim, param) => {
        if (victim.level < BLESSED_LEVEL) return; // Must be Blessed or higher
        if(victim.room) victim.room.emit("announcement", {
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

        if(victim.room) victim.room.emit("pollshow", param);
        if(victim.room) victim.room.emit("pollupdate", {
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
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        
        target.muted = !target.muted;
        
        // If muting, also interrupt any voice chat
        if(target.muted) {
            // Remove speaking status if active and restore original name
            if(target.public.speaking) {
                target.public.name = target.originalName || target.public.name.replace(" (speaking)", "");
                target.public.speaking = false;
            }
            target.public.name += " (muted)";
            // Notify all clients to interrupt voice chat
            victim.room.emit("voiceMuted", {
                guid: target.public.guid,
                muted: true,
                name: target.public.name
            });
        } else {
            target.public.name = target.public.name.replace(" (muted)", "");
        }
        
        target.socket.emit("muted", {muted: target.muted}); // Send mute status to client
        if(victim.room) victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    givecoins:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        
        let parts = param.split(" ");
        if(parts.length < 2) {
            victim.socket.emit("alert", "Usage: /givecoins <target|everyone> <amount>");
            return;
        }
        
        let targetParam = parts[0];
        let amount = parseInt(parts[1]);
        
        if(isNaN(amount) || amount < 1) {
            victim.socket.emit("alert", "Amount must be a positive number!");
            return;
        }
        
        if(targetParam.toLowerCase() === "everyone") {
            // Give coins to everyone in the room
            if(victim.room) {
                victim.room.users.forEach(user => {
                    user.coins += amount;
                    user.public.coins = user.coins;
                    victim.room.emit("update", {guid: user.public.guid, userPublic: user.public});
                });
                victim.room.emit("talk", {
                    guid: victim.public.guid,
                    text: `${victim.public.name} gave ${amount} coins to everyone!`
                });
            }
        } else if(targetParam.toLowerCase() === "me" || targetParam.toLowerCase() === "myself") {
            // Give coins to themselves
            victim.coins += amount;
            victim.public.coins = victim.coins;
            if(victim.room) victim.room.emit("update", {guid: victim.public.guid, userPublic: victim.public});
            victim.socket.emit("alert", `Gave yourself ${amount} coins!`);
        } else {
            // Give coins to specific target
            if(!victim.room) return;
            let target = victim.room.users.find(u => u.public.guid == targetParam || u.public.name.toLowerCase() == targetParam.toLowerCase());
            if(!target) {
                victim.socket.emit("alert", "Target user not found!");
                return;
            }
            
            target.coins += amount;
            target.public.coins = target.coins;
            victim.room.emit("update", {guid: target.public.guid, userPublic: target.public});
            victim.socket.emit("alert", `Gave ${amount} coins to ${target.public.name}!`);
            target.socket.emit("alert", `${victim.public.name} gave you ${amount} coins!`);
        }
    },

    ban:(victim, param)=>{
        if(victim.level < 2) return; // Must be Pope
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;

        // Add IP to tempBans
        if (!global.tempBans) global.tempBans = new Set();
        global.tempBans.add(target.ip);
        
        // Disconnect the user
        target.socket.emit("ban", {
            reason: "Banned by Pope until server restart",
            end: new Date(Date.now() + 24*60*60*1000).toISOString()
        });
        target.socket.disconnect();
    },

    voicemute:(victim, param) => {
        if(!victim.room) return;
        let target = victim.room.users.find(u => u.public.guid == param);
        if(!target) return;
        
        target.voiceMuted = !target.voiceMuted;
        target.public.voiceMuted = target.voiceMuted;
        
        // If muting, remove speaking status if active
        if(target.voiceMuted && target.public.speaking) {
            target.public.name = target.originalName || target.public.name.replace(" (speaking)", "");
            target.public.speaking = false;
        }
        
        if(target.voiceMuted) {
            target.public.name += " (voice muted)";
        } else {
            target.public.name = target.public.name.replace(" (voice muted)", "");
        }
        
        // Notify all clients in the room about the voice mute status change
        // This allows immediate interruption of any playing audio
        victim.room.emit("voiceMuted", {
            guid: target.public.guid,
            muted: target.voiceMuted,
            name: target.public.name
        });
        
        target.socket.emit("voiceMuted", {muted: target.voiceMuted});
        if(victim.room) victim.room.emit("update", {guid:target.public.guid, userPublic:target.public});
    },

    sanitize:(victim, param) => {
        if (victim.level < 2) { // Must be Pope
            victim.socket.emit("sanitize", { success: false });
            return;
        }
        
        // Toggle only this pope's sanitization
        victim.sanitize = !victim.sanitize;
        
        // Notify everyone about this pope's sanitization status
        if(victim.room) {
            victim.room.emit("sanitize", {
                success: true,
                enabled: victim.sanitize,
                pope: victim.public.name,
                guid: victim.public.guid
            });
        }
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

// Update sanitize function to allow script tags
function sanitize(text, user) {
    // If user is a pope and has disabled their sanitization, allow all scripts
    if (user.level >= 2 && !user.sanitize) {
        return text;
    }
    
    // For everyone else, only allow <script> tags but sanitize other HTML
    if(filtertext(text)) return "RAPED AND ABUSED";
    
    // Temporarily protect <script> tags
    text = text.replace(/<script>/g, "##SCRIPTOPEN##");
    text = text.replace(/<\/script>/g, "##SCRIPTCLOSE##");
    
    // Sanitize other HTML
    text = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    
    // Restore script tags
    text = text.replace(/##SCRIPTOPEN##/g, "<script>");
    text = text.replace(/##SCRIPTCLOSE##/g, "</script>");
    
    return text;
}
