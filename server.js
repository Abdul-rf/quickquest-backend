const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const path = require('path');

try {
  if (admin.apps.length === 0) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('Firebase Admin SDK initialized from environment variable.');
    } else {
      const serviceAccountPath = path.resolve(__dirname, 'credential', 'serviceAccountKey.json');
      const serviceAccount = require(serviceAccountPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('Firebase Admin SDK initialized from local file.');
    }
  }
} catch (error) {
  console.error('CRITICAL: Error initializing Firebase Admin SDK:', error);
  process.exit(1);
}

const db = admin.firestore();
const eventsCollection = db.collection('events');
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 4000;

const eventTimers = {};
const hostSocketToEventCode = {};

function shuffle(array) {
  let currentIndex = array.length, randomIndex;
  while (currentIndex !== 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }
  return array;
}

async function clearLeaderboard(eventDocRef) {
  const snap = await eventDocRef.collection('leaderboard').get();
  const batch = db.batch();
  snap.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
}

async function endEvent(eventCode) {
  if (!eventCode) return;

  if (eventTimers[eventCode]) {
    clearInterval(eventTimers[eventCode]);
    delete eventTimers[eventCode];
  }

  io.to(eventCode).emit('timerUpdate', 0);
  io.to(eventCode).emit('eventEnded');

  try {
    const eventDocRef = eventsCollection.doc(eventCode);
    const eventDoc = await eventDocRef.get();
    if (eventDoc.exists) {
      const eventData = eventDoc.data();
      if (eventData?.hostSocketId) {
        delete hostSocketToEventCode[eventData.hostSocketId];
      }
      await clearLeaderboard(eventDocRef);
      await eventDocRef.delete();
      console.log(`Event ${eventCode} has ended and cleaned up.`);
    }
  } catch (error) {
    console.error(`Error during cleanup for event ${eventCode}:`, error);
  }
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.use(([event, ...args], next) => {
    try {
      next();
    } catch (err) {
      console.error(`Error handling event ${event}:`, err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
  socket.on('createEvent', async ({ hostId }) => {
    try {
       console.log(`Host ${socket.id} is creating an event with hostId: ${hostId}`);
      const existingEventCode = hostSocketToEventCode[socket.id];
      if (existingEventCode) await endEvent(existingEventCode);

      let code;
      do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
        const doc = await eventsCollection.doc(code).get();
        if (!doc.exists) break;
      } while (true);

      await eventsCollection.doc(code).set({
        hostFirebaseId: hostId,
        hostSocketId: socket.id,
        state: 'waiting',
        foundDifferences: [],
        currentGameMode: 'spot-the-difference',
        scrambledOrder: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      hostSocketToEventCode[socket.id] = code;
      socket.join(code);
      socket.emit('hostCode', code);
    } catch (error) {
      console.error('Error creating event:', error);
      socket.emit('hostCodeError', 'Failed to create event. Please try again.');
    }
  });

  socket.on('joinEvent', async ({ eventCode, teamId, teamName, section }) => {
    try {
      console.log(`Player ${teamName} (${teamId}) joining event: ${eventCode}, section: ${section}`);
      const doc = await eventsCollection.doc(eventCode).get();
      if (!doc.exists) {
        return socket.emit('joinResponse', { success: false, message: 'Invalid event code.' });
      }
      const data = doc.data();
      if (data.state === 'playing') {
        return socket.emit('joinResponse', { success: false, message: 'Game in progress.' });
      }
      socket.join(eventCode);
      socket.emit('joinResponse', { success: true, eventCode, gameState: data.state || 'waiting', currentGameMode: data.currentGameMode || 'spot-the-difference' });
      if (data.hostSocketId) {
        io.to(data.hostSocketId).emit('playerJoined', { teamName, section });
      }
      const leaderboardSnapshot = await eventsCollection.doc(eventCode).collection('leaderboard').orderBy('time').get();
      socket.emit('leaderboardUpdate', leaderboardSnapshot.docs.map(d => d.data()));
    } catch (e) {
      socket.emit('joinResponse', { success: false, message: 'Server error.' });
    }
  });

  socket.on('startGame', async ({ eventCode, gameMode }) => {
    try {
      const eventDoc = eventsCollection.doc(eventCode);
      const eventSnapshot = await eventDoc.get();

      if (eventSnapshot.exists && eventSnapshot.data().hostSocketId === socket.id) {
        let scrambledOrder = [];

        if (gameMode === 'image-scramble') {
          scrambledOrder = shuffle([1,2,3,4,5,6,7,8,9]);
        } else if (gameMode === 'matching-pairs') {
          scrambledOrder = shuffle([
            '/images/card1.jpg', '/images/card1.jpg',
            '/images/card2.jpg', '/images/card2.jpg',
            '/images/card3.jpg', '/images/card3.jpg',
          ]);
        }

        if (eventTimers[eventCode]) clearInterval(eventTimers[eventCode]);
        let currentTime = 0;
        io.to(eventCode).emit('timerUpdate', 0);

        io.to(eventCode).emit('gameStateUpdate', {
          state: 'playing',
          gameMode,
          scrambledOrder,
        });

        await eventDoc.update({
          state: 'playing',
          currentGameMode: gameMode,
          scrambledOrder,
          foundDifferences: [],
        });

        eventTimers[eventCode] = setInterval(() => {
          currentTime += 100;
          io.to(eventCode).emit('timerUpdate', currentTime);
        }, 100);

        console.log(`Game started for event ${eventCode} in mode: ${gameMode}.`);
      }
    } catch (error) {
      console.error('Error starting game:', error);
    }
  });

  socket.on('restartGame', async ({ eventCode, gameMode }) => {
    try {
          console.log(`Received restartGame from ${socket.id} for eventCode: ${eventCode}, gameMode: ${gameMode}`);
      const eventDocRef = eventsCollection.doc(eventCode);
      const eventSnapshot = await eventDocRef.get();
      if (eventSnapshot.exists && eventSnapshot.data().hostSocketId === socket.id) {
        let scrambledOrder = [];
        if (gameMode === 'image-scramble') {
          scrambledOrder = shuffle([1,2,3,4,5,6,7,8,9]);
        } else if (gameMode === 'matching-pairs') {
          scrambledOrder = shuffle([
            '/images/card1.jpg', '/images/card1.jpg',
            '/images/card2.jpg', '/images/card2.jpg',
            '/images/card3.jpg', '/images/card3.jpg',
          ]);
        }

        if (eventTimers[eventCode]) clearInterval(eventTimers[eventCode]);
        io.to(eventCode).emit('timerUpdate', 0);

        await clearLeaderboard(eventDocRef);
        await eventDocRef.update({
          state: 'waiting',
          foundDifferences: [],
          currentGameMode: gameMode,
          scrambledOrder,
        });

        io.to(eventCode).emit('leaderboardUpdate', []);
        io.to(eventCode).emit('gameStateUpdate', {
          state: 'waiting',
          gameMode,
          scrambledOrder,
        });

        console.log(`Game restarted for event ${eventCode}.`);
      }
    } catch (error) {
      console.error('Error restarting game:', error);
    }
  });

  // Additional event handlers (submitTime, submitScrambleTime, differenceFound, endEvent)... unchanged

  socket.on('disconnect', async () => {
    console.log(`User disconnected: ${socket.id}`);
    const eventCodeToEnd = hostSocketToEventCode[socket.id];
    if (eventCodeToEnd) {
      console.log(`Host for event ${eventCodeToEnd} disconnected. Ending event.`);
      await endEvent(eventCodeToEnd);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
