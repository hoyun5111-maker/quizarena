const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Statik dosyaları PUBLIC klasöründen okur
app.use(express.static(path.join(__dirname, 'public')));

// Rotalar PUBLIC klasörüne yönlendirildi
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const rooms = {};

io.on('connection', (socket) => {
    console.log('Yeni bağlantı:', socket.id);

    // 1. ADMİN: ODA OLUŞTURMA
    socket.on('createRoom', (data) => {
        if (!data || !data.roomId) {
            return socket.emit('loginError', 'Oda kodu eksik!');
        }
        const roomId = data.roomId.toUpperCase().trim();
        rooms[roomId] = {
            adminId: socket.id,
            players: [],
            currentQuestion: null,
            questionStartTime: 0,
            questionDuration: 0,
            activeInterval: null,
            streamId: null,
            chatId: null
        };
        socket.join(roomId);
        console.log(`Oda oluşturuldu: ${roomId}`);
        socket.emit('roomCreated', roomId);
    });

    // 2. OYUNCU: ODAYA KATILMA (GİRİŞTE YAYIN DESTEKLİ)
    socket.on('joinRoom', (data) => {
        if (!data || !data.roomId || !data.username) {
            return socket.emit('loginError', 'Giriş bilgileri eksik!');
        }
        const roomId = data.roomId.toUpperCase().trim();
        const username = data.username.trim();

        if (!rooms[roomId]) {
            return socket.emit('loginError', 'Böyle bir oda bulunamadı!');
        }

        const nameExists = rooms[roomId].players.some(p => p.username.toLowerCase() === username.toLowerCase());
        if (nameExists) {
            return socket.emit('loginError', 'Bu kullanıcı adı zaten alınmış!');
        }

        const newPlayer = {
            socketId: socket.id,
            username: username,
            score: 0
        };

        rooms[roomId].players.push(newPlayer);
        socket.join(roomId);

        // OYUNCUYA BAŞARILI GİRİŞ SİNYALİ GÖNDER
        socket.emit('joinedSuccessfully', roomId);
        
        // EĞER ADMİN DAHA ÖNCE YAYIN BAŞLATTIYSA VEYA SORU GÖNDERDİYSE, OYUNCU GİRER GİRMEZ EKRANLARI AÇILSIN
        if (rooms[roomId].streamId || rooms[roomId].chatId) {
            socket.emit('initMedia', {
                streamId: rooms[roomId].streamId,
                chatId: rooms[roomId].chatId
            });
        } else if (rooms[roomId].currentQuestion) {
            socket.emit('initMedia', {
                streamId: rooms[roomId].currentQuestion.streamId || null,
                chatId: rooms[roomId].currentQuestion.chatId || null
            });
        }

        io.to(roomId).emit('updatePlayers', rooms[roomId].players);
    });

    // 3. ADMİN: YENİ SORU BAŞLATMA
    socket.on('startQuestion', (data) => {
        if (!data || !data.roomId) return;
        const roomId = data.roomId.toUpperCase().trim();
        const room = rooms[roomId];
        if (!room) return;

        if (room.activeInterval) clearInterval(room.activeInterval);

        // Yayın ve Chat ID'lerini oda hafızasında güncelle (Giriş yapanlar anında görsün diye)
        if (data.streamId) room.streamId = data.streamId.trim();
        if (data.chatId) room.chatId = data.chatId.trim();

        room.questionStartTime = Date.now();
        room.questionDuration = parseInt(data.timeLeft) || 30;
        room.currentQuestion = {
            text: data.text,
            answer: data.answer ? data.answer.trim().toLowerCase() : "",
            mode: data.mode || "quiz",
            type: data.type || "text",
            options: data.options || [],
            streamId: room.streamId,
            chatId: room.chatId
        };

        const clientData = {
            text: data.text,
            mode: data.mode,
            type: data.type,
            options: data.options,
            timeLeft: room.questionDuration,
            streamId: room.streamId,
            chatId: room.chatId
        };

        io.to(roomId).emit('newQuestion', clientData);

        let counter = room.questionDuration;
        room.activeInterval = setInterval(() => {
            counter--;
            if (counter <= 0) {
                clearInterval(room.activeInterval);
                io.to(roomId).emit('timeUp');
            }
        }, 1000);
    });

    // 4. OYUNCU: CEVAP GÖNDERME
    socket.on('submitAnswer', (data) => {
        if (!data || !data.roomId || data.answer === undefined) return;
        const roomId = data.roomId.toUpperCase().trim();
        const room = rooms[roomId];
        if (!room || !room.currentQuestion) return;

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) return;

        const userAnswer = data.answer.toString().trim().toLowerCase();
        const correctAnswer = room.currentQuestion.answer;
        let isCorrect = (userAnswer === correctAnswer);

        if (isCorrect) {
            if (room.currentQuestion.mode === 'tabu') {
                if (room.activeInterval) clearInterval(room.activeInterval);
                player.score += 100;
                io.to(roomId).emit('tabuWin', { winner: player.username, word: room.currentQuestion.answer });
                io.to(roomId).emit('updatePlayers', room.players);
            } else {
                const timePassed = Math.floor((Date.now() - room.questionStartTime) / 1000);
                const timeLeft = Math.max(0, room.questionDuration - timePassed);
                const speedBonus = timeLeft * 5;
                const totalEarned = 100 + speedBonus;

                player.score += totalEarned;
                socket.emit('answerReceived', { isCorrect: true, currentScore: player.score });
                io.to(roomId).emit('updatePlayers', room.players);
            }
        } else {
            socket.emit('answerReceived', { isCorrect: false, currentScore: player.score });
        }
    });

    // 5. ADMİN: SÜREYİ KESME
    socket.on('adminForceTimeUp', (data) => {
        if (!data || !data.roomId) return;
        const roomId = data.roomId.toUpperCase().trim();
        const room = rooms[roomId];
        if (room) {
            if (room.activeInterval) clearInterval(room.activeInterval);
            io.to(roomId).emit('timeUp');
        }
    });

    // 6. BAĞLANTI KOPMA YÖNETİMİ
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room.adminId === socket.id) {
                if (room.activeInterval) clearInterval(room.activeInterval);
                io.to(roomId).emit('loginError', 'Admin oyundan ayrıldı.');
                delete rooms[roomId];
                break;
            }
            const pIndex = room.players.findIndex(p => p.socketId === socket.id);
            if (pIndex !== -1) {
                room.players.splice(pIndex, 1);
                io.to(roomId).emit('updatePlayers', room.players);
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda güvenle açıldı kanka! 🚀`);
});
