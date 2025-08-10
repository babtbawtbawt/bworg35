
class VoiceChat {
    constructor() {
        this.socket = null;
        this.localStream = null;
        this.peers = new Map();
        this.audioAnalysers = new Map();
        this.isConnected = false;
        this.isMuted = false;
        this.isDeafened = false;
        this.username = '';
        this.roomId = '';
        this.participants = new Map();
        this.isScreensharing = false;
        this.screensharePeers = new Map();
        this.screenshareStream = null;
        this.isViewingScreenshare = false;
        
        this.initializeElements();
        this.setupEventListeners();
        this.setupAudioContext();
    }

    initializeElements() {
        this.elements = {
            username: document.getElementById('username'),
            roomId: document.getElementById('roomId'),
            joinBtn: document.getElementById('joinBtn'),
            muteBtn: document.getElementById('muteBtn'),
            deafenBtn: document.getElementById('deafenBtn'),
            leaveBtn: document.getElementById('leaveBtn'),
            controls: document.getElementById('controls'),
            voiceArea: document.getElementById('voiceArea'),
            voiceControls: document.getElementById('voiceControls'),
            status: document.getElementById('status'),
            voiceParticipants: document.getElementById('voiceParticipants'),
            volumeSlider: document.getElementById('volumeSlider'),
            volumeValue: document.getElementById('volumeValue'),
            errorModal: document.getElementById('errorModal'),
            errorMessage: document.getElementById('errorMessage'),
            screenshareBtn: document.getElementById('screenshareBtn'),
            screenshareArea: document.getElementById('screenshareArea'),
            screenshareVideo: document.getElementById('screenshareVideo'),
            screenshareUser: document.getElementById('screenshareUser'),
            closeScreenshare: document.getElementById('closeScreenshare')
        };
    }

    setupEventListeners() {
        this.elements.joinBtn.addEventListener('click', () => this.joinVoiceChat());
        this.elements.leaveBtn.addEventListener('click', () => this.leaveVoiceChat());
        this.elements.muteBtn.addEventListener('click', () => this.toggleMute());
        this.elements.deafenBtn.addEventListener('click', () => this.toggleDeafen());
        this.elements.screenshareBtn.addEventListener('click', () => this.toggleScreenshare());
        this.elements.closeScreenshare.addEventListener('click', () => this.stopViewingScreenshare());
        this.elements.volumeSlider.addEventListener('input', (e) => {
            this.setVolume(e.target.value);
        });

        // Close modal
        document.querySelector('.close').addEventListener('click', () => {
            this.elements.errorModal.style.display = 'none';
        });

        // Enter key for username/room
        this.elements.username.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.joinVoiceChat();
        });
        this.elements.roomId.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.joinVoiceChat();
        });
    }

    setupAudioContext() {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this.audioElements = new Map();
    }

    async joinVoiceChat() {
        const username = this.elements.username.value.trim();
        const roomId = this.elements.roomId.value.trim() || 'default';

        if (!username) {
            this.showError('Please enter a username');
            return;
        }

        if (username.length > 25) {
            this.showError('Username must be 25 characters or less');
            return;
        }

        this.username = username;
        this.roomId = roomId;

        try {
            this.setStatus('Connecting...', 'connecting');
            await this.initializeMedia();
            this.connectToServer();
        } catch (error) {
            this.showError('Failed to access microphone: ' + error.message);
            this.setStatus('Disconnected');
        }
    }

    async initializeMedia() {
        this.localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        
        // Setup speaking detection
        this.setupSpeakingDetection();
    }

    setupSpeakingDetection() {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        const microphone = audioContext.createMediaStreamSource(this.localStream);
        
        analyser.fftSize = 512;
        analyser.minDecibels = -127;
        analyser.maxDecibels = 0;
        analyser.smoothingTimeConstant = 0.4;
        
        microphone.connect(analyser);
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        let isSpeaking = false;
        
        const checkSpeaking = () => {
            analyser.getByteFrequencyData(dataArray);
            
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
            }
            const average = sum / dataArray.length;
            
            const speaking = average > 20 && !this.isMuted;
            
            if (speaking !== isSpeaking) {
                isSpeaking = speaking;
                if (this.socket) {
                    this.socket.emit('speaking-state', { isSpeaking: speaking });
                }
                this.updateLocalSpeakingState(speaking);
            }
            
            requestAnimationFrame(checkSpeaking);
        };
        
        checkSpeaking();
    }

    updateLocalSpeakingState(speaking) {
        const localParticipant = document.querySelector(`[data-user-id="local"]`);
        if (localParticipant) {
            const avatar = localParticipant.querySelector('.voice-avatar');
            if (speaking) {
                avatar.classList.add('speaking');
            } else {
                avatar.classList.remove('speaking');
            }
        }
    }

    connectToServer() {
        this.socket = io('/voice-chat');
        
        this.socket.on('connect', () => {
            this.socket.emit('join-voice-room', {
                username: this.username,
                roomId: this.roomId
            });
        });

        this.socket.on('joined-voice-room', (data) => {
            this.isConnected = true;
            this.setStatus('Connected', 'connected');
            this.elements.controls.style.display = 'none';
            this.elements.voiceArea.style.display = 'flex';
            
            // Filter out current user from participants list to avoid duplicates
            const otherParticipants = data.participants.filter(p => p.userId !== this.socket.id);
            this.updateParticipants(otherParticipants);
            this.addLocalParticipant();
            
            // Create offers for existing participants (excluding self)
            otherParticipants.forEach(participant => {
                this.createOffer(participant.userId);
            });
        });

        this.socket.on('user-joined-voice', (data) => {
            this.participants.set(data.userId, data);
            this.updateParticipantDisplay();
        });

        this.socket.on('user-left-voice', (data) => {
            this.participants.delete(data.userId);
            this.updateParticipantDisplay();
            
            if (this.peers.has(data.userId)) {
                this.peers.get(data.userId).close();
                this.peers.delete(data.userId);
            }
            
            if (this.screensharePeers.has(data.userId)) {
                this.screensharePeers.get(data.userId).close();
                this.screensharePeers.delete(data.userId);
                // If we were viewing their screenshare, close it
                if (this.isViewingScreenshare) {
                    this.stopViewingScreenshare();
                }
            }
            
            if (this.audioElements.has(data.userId)) {
                this.audioElements.get(data.userId).remove();
                this.audioElements.delete(data.userId);
            }
        });

        this.socket.on('voice-offer', async (data) => {
            await this.handleVoiceOffer(data);
        });

        this.socket.on('voice-answer', async (data) => {
            await this.handleVoiceAnswer(data);
        });

        this.socket.on('voice-ice-candidate', async (data) => {
            await this.handleIceCandidate(data);
        });

        this.socket.on('user-muted', (data) => {
            if (this.participants.has(data.userId)) {
                this.participants.get(data.userId).isMuted = data.isMuted;
                this.updateParticipantMuteState(data.userId, data.isMuted);
            }
        });

        this.socket.on('user-speaking', (data) => {
            this.updateParticipantSpeakingState(data.userId, data.isSpeaking);
        });

        this.socket.on('screenshare-started', (data) => {
            if (data.userId !== this.socket.id) {
                // Someone else started screensharing
                if (this.participants.has(data.userId)) {
                    this.participants.get(data.userId).isScreensharing = true;
                    this.updateParticipantDisplay();
                }
                this.elements.screenshareUser.textContent = data.username;
                this.startViewingScreenshare(data.userId);
            } else {
                // Our own screenshare started
                this.isScreensharing = true;
                this.elements.screenshareBtn.textContent = '📺 Stop Sharing';
                this.elements.screenshareBtn.classList.add('screensharing');
                this.broadcastScreenshare();
            }
        });

        this.socket.on('screenshare-stopped', (data) => {
            if (data.userId !== this.socket.id) {
                // Someone else stopped screensharing
                if (this.participants.has(data.userId)) {
                    this.participants.get(data.userId).isScreensharing = false;
                    this.updateParticipantDisplay();
                }
                if (this.screensharePeers.has(data.userId)) {
                    this.screensharePeers.get(data.userId).close();
                    this.screensharePeers.delete(data.userId);
                }
                this.stopViewingScreenshare();
            } else {
                // Our own screenshare stopped
                this.isScreensharing = false;
                this.elements.screenshareBtn.textContent = '📺 Share Screen';
                this.elements.screenshareBtn.classList.remove('screensharing');
            }
        });

        this.socket.on('screenshare-denied', (data) => {
            this.showError(data.reason);
        });

        this.socket.on('screenshare-offer', async (data) => {
            await this.handleScreenshareOffer(data);
        });

        this.socket.on('screenshare-answer', async (data) => {
            await this.handleScreenshareAnswer(data);
        });

        this.socket.on('screenshare-ice-candidate', async (data) => {
            await this.handleScreenshareIceCandidate(data);
        });

        this.socket.on('error', (error) => {
            this.showError(error.message);
        });

        this.socket.on('disconnect', () => {
            this.setStatus('Disconnected');
            this.isConnected = false;
            this.cleanup();
        });
    }

    async handleVoiceOffer(data) {
        const peerConnection = this.createPeerConnection(data.from);
        this.peers.set(data.from, peerConnection);

        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        
        this.localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, this.localStream);
        });

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        this.socket.emit('voice-answer', {
            to: data.from,
            answer: answer
        });
    }

    async handleVoiceAnswer(data) {
        const peerConnection = this.peers.get(data.from);
        if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
    }

    async handleIceCandidate(data) {
        const peerConnection = this.peers.get(data.from);
        if (peerConnection) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
    }

    createPeerConnection(userId) {
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        };

        const peerConnection = new RTCPeerConnection(configuration);

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('voice-ice-candidate', {
                    to: userId,
                    candidate: event.candidate
                });
            }
        };

        peerConnection.ontrack = (event) => {
            this.handleRemoteStream(userId, event.streams[0]);
        };

        return peerConnection;
    }

    handleRemoteStream(userId, stream) {
        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.volume = this.elements.volumeSlider.value / 100;
        
        this.audioElements.set(userId, audio);
        document.body.appendChild(audio);
    }

    async createOffer(userId) {
        const peerConnection = this.createPeerConnection(userId);
        this.peers.set(userId, peerConnection);

        this.localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, this.localStream);
        });

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        this.socket.emit('voice-offer', {
            to: userId,
            offer: offer
        });
    }

    addLocalParticipant() {
        const colors = ['purple', 'red', 'blue', 'green', 'brown', 'black', 'pink'];
        const randomColor = colors[Math.floor(Math.random() * colors.length)];
        
        const participantDiv = document.createElement('div');
        participantDiv.className = 'voice-participant';
        participantDiv.setAttribute('data-user-id', 'local');
        
        participantDiv.innerHTML = `
            <div class="voice-avatar">
                <img src="head.png" class="bonzi-head ${randomColor}" alt="${this.escapeHtml(this.username)}">
                <div class="mute-indicator">🔇</div>
            </div>
            <div class="voice-username">${this.escapeHtml(this.username)} (You)</div>
        `;
        
        this.elements.voiceParticipants.appendChild(participantDiv);
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        
        if (this.localStream) {
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = !this.isMuted;
            });
        }

        this.elements.muteBtn.textContent = this.isMuted ? '🔇 Unmute' : '🎤 Mute';
        this.elements.muteBtn.classList.toggle('muted', this.isMuted);

        // Update local avatar
        const localParticipant = document.querySelector(`[data-user-id="local"]`);
        if (localParticipant) {
            const avatar = localParticipant.querySelector('.voice-avatar');
            if (this.isMuted) {
                avatar.classList.add('muted');
                localParticipant.classList.add('muted');
            } else {
                avatar.classList.remove('muted');
                localParticipant.classList.remove('muted');
            }
        }

        if (this.socket) {
            this.socket.emit('toggle-mute', { isMuted: this.isMuted });
        }
    }

    toggleDeafen() {
        this.isDeafened = !this.isDeafened;
        
        this.audioElements.forEach(audio => {
            audio.volume = this.isDeafened ? 0 : this.elements.volumeSlider.value / 100;
        });

        this.elements.deafenBtn.textContent = this.isDeafened ? '🔇 Undeafen' : '🔊 Deafen';
        this.elements.deafenBtn.classList.toggle('muted', this.isDeafened);
    }

    setVolume(value) {
        this.elements.volumeValue.textContent = value + '%';
        
        if (!this.isDeafened) {
            this.audioElements.forEach(audio => {
                audio.volume = value / 100;
            });
        }
    }

    updateParticipants(participants) {
        this.participants.clear();
        participants.forEach(participant => {
            this.participants.set(participant.userId, participant);
        });
        this.updateParticipantDisplay();
    }

    updateParticipantDisplay() {
        // Clear existing remote participants (keep local)
        const remoteParticipants = this.elements.voiceParticipants.querySelectorAll('.voice-participant:not([data-user-id="local"])');
        remoteParticipants.forEach(p => p.remove());

        this.participants.forEach(participant => {
            const participantDiv = document.createElement('div');
            participantDiv.className = 'voice-participant';
            participantDiv.setAttribute('data-user-id', participant.userId);
            if (participant.isMuted) {
                participantDiv.classList.add('muted');
            }
            
            participantDiv.innerHTML = `
                <div class="voice-avatar ${participant.isMuted ? 'muted' : ''}">
                    <img src="head.png" class="bonzi-head ${participant.color || 'purple'}" alt="${this.escapeHtml(participant.username)}">
                    <div class="mute-indicator">🔇</div>
                </div>
                <div class="voice-username">${this.escapeHtml(participant.username)}${participant.isScreensharing ? ' 📺' : ''}</div>
            `;
            
            if (participant.isScreensharing) {
                participantDiv.classList.add('screensharing');
            }
            
            this.elements.voiceParticipants.appendChild(participantDiv);
        });
    }

    updateParticipantMuteState(userId, isMuted) {
        const participant = document.querySelector(`[data-user-id="${userId}"]`);
        if (participant) {
            const avatar = participant.querySelector('.voice-avatar');
            if (isMuted) {
                avatar.classList.add('muted');
                participant.classList.add('muted');
            } else {
                avatar.classList.remove('muted');
                participant.classList.remove('muted');
            }
        }
    }

    updateParticipantSpeakingState(userId, isSpeaking) {
        const participant = document.querySelector(`[data-user-id="${userId}"]`);
        if (participant) {
            const avatar = participant.querySelector('.voice-avatar');
            if (isSpeaking) {
                avatar.classList.add('speaking');
            } else {
                avatar.classList.remove('speaking');
            }
        }

        // Also update screenshare participants if screenshare is active
        const screenshareParticipant = document.querySelector(`.screenshare-participants [data-user-id="${userId}"]`);
        if (screenshareParticipant) {
            const screenshareAvatar = screenshareParticipant.querySelector('.screenshare-avatar');
            if (isSpeaking) {
                screenshareAvatar.classList.add('speaking');
            } else {
                screenshareAvatar.classList.remove('speaking');
            }
        }
    }

    setStatus(text, className = '') {
        this.elements.status.textContent = text;
        this.elements.status.className = className;
    }

    showError(message) {
        this.elements.errorMessage.textContent = message;
        this.elements.errorModal.style.display = 'flex';
    }

    leaveVoiceChat() {
        if (this.socket) {
            this.socket.disconnect();
        }
        this.cleanup();
        this.resetUI();
    }

    cleanup() {
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        if (this.screenshareStream) {
            this.screenshareStream.getTracks().forEach(track => track.stop());
            this.screenshareStream = null;
        }

        this.peers.forEach(peer => peer.close());
        this.peers.clear();

        this.screensharePeers.forEach(peer => peer.close());
        this.screensharePeers.clear();

        this.audioElements.forEach(audio => audio.remove());
        this.audioElements.clear();

        this.participants.clear();
        this.stopViewingScreenshare();
    }

    resetUI() {
        this.isConnected = false;
        this.elements.controls.style.display = 'block';
        this.elements.voiceArea.style.display = 'none';
        this.elements.username.disabled = false;
        this.elements.roomId.disabled = false;
        this.setStatus('Disconnected');
        this.elements.voiceParticipants.innerHTML = '';
        this.elements.muteBtn.textContent = '🎤 Mute';
        this.elements.muteBtn.classList.remove('muted');
        this.elements.deafenBtn.textContent = '🔊 Deafen';
        this.elements.deafenBtn.classList.remove('muted');
        this.elements.screenshareBtn.textContent = '📺 Share Screen';
        this.elements.screenshareBtn.classList.remove('screensharing');
        this.isMuted = false;
        this.isDeafened = false;
        this.isScreensharing = false;
        this.isViewingScreenshare = false;
    }

    async toggleScreenshare() {
        if (this.isScreensharing) {
            this.stopScreenshare();
        } else {
            await this.startScreenshare();
        }
    }

    async startScreenshare() {
        try {
            this.screenshareStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    mediaSource: 'screen'
                },
                audio: true
            });
            
            // Handle when user stops sharing via browser UI
            this.screenshareStream.getVideoTracks()[0].addEventListener('ended', () => {
                this.stopScreenshare();
            });
            
            this.socket.emit('start-screenshare');
        } catch (error) {
            this.showError('Failed to start screenshare: ' + error.message);
        }
    }

    stopScreenshare() {
        if (this.screenshareStream) {
            this.screenshareStream.getTracks().forEach(track => track.stop());
            this.screenshareStream = null;
        }
        
        this.screensharePeers.forEach(peer => peer.close());
        this.screensharePeers.clear();
        
        if (this.socket) {
            this.socket.emit('stop-screenshare');
        }
    }

    async broadcastScreenshare() {
        // Send our screenshare to all participants
        this.participants.forEach(async (participant, userId) => {
            await this.createScreenshareOffer(userId);
        });
    }

    async startViewingScreenshare(userId) {
        this.isViewingScreenshare = true;
        // Create peer connection to receive screenshare
        if (!this.screensharePeers.has(userId)) {
            const peerConnection = this.createScreensharePeerConnection(userId);
            this.screensharePeers.set(userId, peerConnection);
        }
    }

    async createScreenshareOffer(userId) {
        const peerConnection = this.createScreensharePeerConnection(userId);
        this.screensharePeers.set(userId, peerConnection);

        // Add screenshare stream tracks
        if (this.screenshareStream) {
            this.screenshareStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, this.screenshareStream);
            });
        }

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        this.socket.emit('screenshare-offer', {
            to: userId,
            offer: offer
        });
    }

    createScreensharePeerConnection(userId) {
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        };

        const peerConnection = new RTCPeerConnection(configuration);

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('screenshare-ice-candidate', {
                    to: userId,
                    candidate: event.candidate
                });
            }
        };

        peerConnection.ontrack = (event) => {
            this.handleScreenshareStream(event.streams[0]);
        };

        peerConnection.onconnectionstatechange = () => {
            if (peerConnection.connectionState === 'failed') {
                this.screensharePeers.delete(userId);
            }
        };

        return peerConnection;
    }

    handleScreenshareStream(stream) {
        this.elements.screenshareVideo.srcObject = stream;
        this.elements.screenshareArea.style.display = 'flex';
        this.displayScreenshareParticipants();
    }

    displayScreenshareParticipants() {
        // Remove existing participants overlay
        const existingOverlay = document.querySelector('.screenshare-participants');
        if (existingOverlay) {
            existingOverlay.remove();
        }

        // Create new participants overlay
        const participantsOverlay = document.createElement('div');
        participantsOverlay.className = 'screenshare-participants';
        
        // Add local participant first
        const localParticipant = document.createElement('div');
        localParticipant.className = 'screenshare-participant';
        localParticipant.setAttribute('data-user-id', 'local');
        localParticipant.innerHTML = `
            <div class="screenshare-avatar ${this.isMuted ? 'muted' : ''}">
                <img src="head.png" class="bonzi-head purple" alt="${this.escapeHtml(this.username)}">
            </div>
            <div class="screenshare-username">${this.escapeHtml(this.username)} (You)</div>
        `;
        participantsOverlay.appendChild(localParticipant);

        // Add remote participants
        this.participants.forEach(participant => {
            const participantDiv = document.createElement('div');
            participantDiv.className = 'screenshare-participant';
            participantDiv.setAttribute('data-user-id', participant.userId);
            
            participantDiv.innerHTML = `
                <div class="screenshare-avatar ${participant.isMuted ? 'muted' : ''}">
                    <img src="head.png" class="bonzi-head ${participant.color || 'purple'}" alt="${this.escapeHtml(participant.username)}">
                </div>
                <div class="screenshare-username">${this.escapeHtml(participant.username)}</div>
            `;
            
            participantsOverlay.appendChild(participantDiv);
        });

        this.elements.screenshareArea.appendChild(participantsOverlay);
    }

    async handleScreenshareOffer(data) {
        const peerConnection = this.screensharePeers.get(data.from) || this.createScreensharePeerConnection(data.from);
        this.screensharePeers.set(data.from, peerConnection);

        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        this.socket.emit('screenshare-answer', {
            to: data.from,
            answer: answer
        });
    }

    async handleScreenshareAnswer(data) {
        const peerConnection = this.screensharePeers.get(data.from);
        if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
    }

    async handleScreenshareIceCandidate(data) {
        const peerConnection = this.screensharePeers.get(data.from);
        if (peerConnection) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
    }

    stopViewingScreenshare() {
        this.isViewingScreenshare = false;
        this.elements.screenshareArea.style.display = 'none';
        this.elements.screenshareVideo.srcObject = null;
        
        // Remove participants overlay
        const participantsOverlay = document.querySelector('.screenshare-participants');
        if (participantsOverlay) {
            participantsOverlay.remove();
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize the voice chat when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new VoiceChat();
});
