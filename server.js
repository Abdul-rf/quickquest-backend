const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const path = require('path');

// --- Firebase Admin SDK Initialization ---
try {
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
} catch (error) {
  console.error('CRITICAL: Error initializing Firebase Admin SDK:', error);
  process.exit(1);
}

const db = admin.firestore();
const eventsCollection = db.collection('events');
const app = express();
const server = http.createServer(app);

// Updated Socket.IO configuration
const io = new Server(server, {
  cors: {
    origin: '*',  // For production, replace '*' with your frontend URL
    methods: ['GET', 'POST'],
    credentials: true,
    allowedHeaders: ['my-custom-header'], // Adjust if necessary
  },
  transports: ['websocket', 'polling'],  // Explicitly enable transports
});

const PORT = process.env.PORT || 4000;
const eventTimers = {};
const hostSocketToEventCode = {};

// All existing backend logic continues unchanged...

// Utility: generate unique 4-digit code not already in Firestore
const generateCode = async () => {
  let code;
  let docExists;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
    const doc = await eventsCollection.doc(code).get();
    docExists = doc.exists;
  } while (docExists);
  return code;
};

const shuffle = (array) => {
  let currentIndex = array.length, randomIndex;
  while (currentIndex !== 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }
  return array;
};

const endEvent = async (eventCode) => {
  if (!eventCode) return;
  console.log(`Ending event ${eventCode}...`);

  if (eventTimers[eventCode]) {
    clearInterval(eventTimers[eventCode]);
    delete eventTimers[eventCode];
  }
  io.to(eventCode).emit('eventEnded');
  try {
    const eventDocRef = eventsCollection.doc(eventCode);
    const eventDoc = await eventDocRef.get();
    if (eventDoc.exists) {
      const eventData = eventDoc.data();
      if (eventData?.hostSocketId) {
        delete hostSocketToEventCode[eventData.hostSocketId];
      }
      await eventDocRef.delete();
      console.log(`Event ${eventCode} has ended and cleaned up.`);
    }
  } catch (error) {
    console.error(`Error during cleanup for event ${eventCode}:`, error);
  }
};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('createEvent', async ({ hostId }) => {
    try {
      const existingEventCode = hostSocketToEventCode[socket.id];
      if (existingEventCode) await endEvent(existingEventCode);

      const newCode = await generateCode();

      await eventsCollection.doc(newCode).set({
        hostFirebaseId: hostId,
        hostSocketId: socket.id,
        state: 'waiting',
        foundDifferences: [],
        currentGameMode: 'spot-the-difference',
        scrambledOrder: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      hostSocketToEventCode[socket.id] = newCode;
      socket.join(newCode);

      socket.emit('hostCode', newCode);
      console.log(`Event created by ${hostId} with code: ${newCode}`);
    } catch (error) {
      console.error('Error creating event:', error);
      socket.emit('hostCodeError', 'Failed to create event. Please try again.');
    }
  });

  socket.on('joinEvent', async ({ eventCode, teamId, teamName, section }) => {
    try {
      const eventDoc = eventsCollection.doc(eventCode);
      const eventSnapshot = await eventDoc.get();
      if (eventSnapshot.exists) {
        const eventData = eventSnapshot.data();
        if (eventData.state === 'playing') {
          return socket.emit('joinResponse', { success: false, message: 'Game in progress.' });
        }
        socket.join(eventCode);
        console.log(`${teamName} joined event ${eventCode}`);
        socket.emit('joinResponse', { success: true, eventCode, gameState: eventData.state || 'waiting', currentGameMode: eventData.currentGameMode || 'spot-the-difference' });
        if (eventData.hostSocketId) {
          io.to(eventData.hostSocketId).emit('playerJoined', { teamName, section });
        }

        const leaderboardSnapshot = await eventDoc.collection('leaderboard').orderBy('time').get();
        socket.emit('leaderboardUpdate', leaderboardSnapshot.docs.map(doc => doc.data()));
      } else {
        socket.emit('joinResponse', { success: false, message: 'Invalid event code.' });
      }
    } catch (error) {
      console.error('Error in joinEvent:', error);
      socket.emit('joinResponse', { success: false, message: 'Server error.' });
    }
  });

  socket.on('startGame', async ({ eventCode, gameMode }) => {
    try {
      const eventDoc = eventsCollection.doc(eventCode);
      const eventSnapshot = await eventDoc.get();
      if (eventSnapshot.exists && eventSnapshot.data().hostSocketId === socket.id) {
        let updateData = { state: 'playing', currentGameMode: gameMode };
        let scrambledOrder = [];
        if (gameMode === 'image-scramble') {
          const correctOrder = [1,2,3,4,5,6,7,8,9];
          scrambledOrder = shuffle([...correctOrder]);
          updateData.scrambledOrder = scrambledOrder;
        } else {
          updateData.scrambledOrder = [];
        }
        await eventDoc.update(updateData);

        // Critical fix: always include gameMode and scrambledOrder on emit
        console.log('Emitting gameStateUpdate:', { state: 'playing', gameMode, scrambledOrder });
        io.to(eventCode).emit('gameStateUpdate', { 
          state: 'playing', 
          gameMode: gameMode || 'spot-the-difference', 
          scrambledOrder: scrambledOrder || [] 
        });

        if (eventTimers[eventCode]) clearInterval(eventTimers[eventCode]);
        let currentTime = 0;
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

  // ... rest of your existing socket handlers unchanged ...

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
  console.log(`Server is running on port ${PORT}`);
});
