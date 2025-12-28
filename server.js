const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// Speicher für Räume
const rooms = {};
const TURN_TIMEOUT = 15000;

// Mapping: SocketID -> RoomID (für schnelles Disconnect Handling)
const socketRoomMap = {};

function generateTrapFields() {
    const traps = [];
    const safeZones = [0, 10, 20, 30]; 
    while(traps.length < 8) {
        const r = Math.floor(Math.random() * 40);
        if(!traps.includes(r) && !safeZones.includes(r)) traps.push(r);
    }
    return traps;
}

function nextTurn(roomId) {
    const room = rooms[roomId];
    if(!room) return;

    if(room.timer) clearTimeout(room.timer);

    // Nächsten Spieler finden
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    const activePlayer = room.players[room.turnIndex];

    // Info Senden
    io.to(roomId).emit('turnChanged', { 
        activeColor: activePlayer.color,
        activeName: activePlayer.name,
        isBot: activePlayer.isBot,
        timeout: TURN_TIMEOUT / 1000
    });

    // Server Timer
    room.timer = setTimeout(() => {
        io.to(roomId).emit('statusMessage', { msg: `Zeit abgelaufen für ${activePlayer.name}!` });
        nextTurn(roomId);
    }, TURN_TIMEOUT);
}

io.on('connection', (socket) => {
    
    socket.on('joinGame', (roomId) => {
        // Falls Raum "hängt" (altes Spiel aber leer), resetten
        if (rooms[roomId] && rooms[roomId].players.filter(p => !p.isBot).length === 0) {
            delete rooms[roomId];
            console.log(`Raum ${roomId} wurde resettet (war leer).`);
        }

        socket.join(roomId);
        socketRoomMap[socket.id] = roomId;

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                status: 'waiting',
                host: socket.id,
                trapFields: generateTrapFields(),
                turnIndex: -1,
                timer: null
            };
        }
        const room = rooms[roomId];

        // Wenn Spiel läuft, Beitritt verweigern (außer Reconnect Logik, hier simpel gehalten)
        if (room.status === 'playing') {
            socket.emit('errorMsg', 'Spiel läuft bereits! Versuche einen anderen Raumnamen.');
            return;
        }

        if (room.players.length < 4) {
            const colors = ['red', 'blue', 'green', 'yellow'];
            const figures = {'red': 'Mörder-Puppe', 'blue': 'Grabkreuz', 'green': 'Grabstein', 'yellow': 'Poltergeist'};
            const playerColor = colors[room.players.length];
            
            const player = {
                id: socket.id,
                color: playerColor,
                isBot: false,
                name: `Spieler ${room.players.length + 1}`,
                figure: figures[playerColor]
            };
            room.players.push(player);

            io.to(roomId).emit('lobbyUpdate', { players: room.players, hostId: room.host });
            socket.emit('setIdentity', { 
                color: playerColor, 
                figure: figures[playerColor],
                isHost: room.host === socket.id 
            });
        } else {
            socket.emit('errorMsg', 'Raum ist voll!');
        }
    });

    socket.on('requestStartGame', (roomId) => {
        const room = rooms[roomId];
        if(!room || room.host !== socket.id) return;

        // Bots hinzufügen
        const colors = ['red', 'blue', 'green', 'yellow'];
        const figures = {'red': 'Mörder-Puppe', 'blue': 'Grabkreuz', 'green': 'Grabstein', 'yellow': 'Poltergeist'};
        
        while(room.players.length < 4) {
            const c = colors[room.players.length];
            room.players.push({
                id: 'BOT_' + Math.random(),
                color: c,
                isBot: true,
                name: 'Bot (' + figures[c] + ')',
                figure: figures[c]
            });
        }

        room.status = 'playing';
        io.to(roomId).emit('gameStarted', {
            players: room.players,
            trapFields: room.trapFields
        });

        room.turnIndex = -1;
        nextTurn(roomId);
    });

    socket.on('rollDice', ({ roomId }) => {
        const room = rooms[roomId];
        if(!room) return;
        if(room.timer) clearTimeout(room.timer);

        const val = Math.floor(Math.random() * 6) + 1;
        io.to(roomId).emit('diceRolled', { playerId: socket.id, value: val });
    });

    socket.on('movePiece', ({ roomId, pieceId, newPosition }) => {
        io.to(roomId).emit('pieceMoved', { 
            playerId: socket.id, 
            pieceId: pieceId, 
            newPosition: newPosition 
        });
    });

    socket.on('endTurn', ({ roomId }) => {
        nextTurn(roomId);
    });

    // WICHTIG: Clean Up beim Disconnect
    socket.on('disconnect', () => {
        const roomId = socketRoomMap[socket.id];
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            
            // Spieler entfernen
            room.players = room.players.filter(p => p.id !== socket.id);
            
            // Checken ob noch echte Menschen da sind
            const humansLeft = room.players.filter(p => !p.isBot).length;
            
            if (humansLeft === 0) {
                // Raum löschen wenn leer
                if(room.timer) clearTimeout(room.timer);
                delete rooms[roomId];
                console.log(`Raum ${roomId} gelöscht (alle weg).`);
            } else {
                // Ggf. Host migrieren oder Spiel abbrechen (hier einfach weitermachen oder Lobby Update)
                if(room.status === 'waiting') {
                    io.to(roomId).emit('lobbyUpdate', { players: room.players, hostId: room.players[0].id });
                    room.host = room.players[0].id;
                }
            }
        }
        delete socketRoomMap[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
