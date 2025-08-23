const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const path = require('path');

// --- Firebase Admin SDK Initialization ---
// This new block reads credentials from an environment variable,
// which is more secure and necessary for deployment platforms like Render.
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // On Render/production, parse the environment variable
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized from environment variable.');
  } else {
    // For local development, fall back to the local file
    const serviceAccountPath = path.resolve(__dirname, 'credential', 'serviceAccountKey.json');
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized from local file.');
  }
} catch (error) {
  console.error('CRITICAL: Error initializing Firebase Admin SDK:', error);
  // Exit the process if Firebase cannot be initialized, as the app cannot run without it.
  process.exit(1);
}


const db = admin.firestore();
const eventsCollection = db.collection('events');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Be more specific in production for better security
    methods: ['GET', 'POST'],
  }
});

const PORT = process.env.PORT || 4000;

// In-Memory State (consider moving to a more persistent store like Redis for larger scale)
const eventTimers = {};
const hostSocketToEventCode = {};

/**
 * Generates a unique 4-digit event code that is not currently in use.
 * @returns {Promise<string>} A unique 4-digit code.
 */
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

/**
 * Ends an event, cleans up timers, notifies clients, and deletes the event from Firestore.
 * @param {string} eventCode The code of the event to end.
 */
const endEvent = async (eventCode) => {
  if (!eventCode) return;

  console.log(`Ending event ${eventCode}...`);

  // Clear any running timers for this event
  if (eventTimers[eventCode]) {
    clearInterval(eventTimers[eventCode]);
    delete eventTimers[eventCode];
  }

  // Notify all clients in the room that the event has ended
  io.to(eventCode).emit('eventEnded');

  try {
    const eventDocRef = eventsCollection.doc(eventCode);
    const eventDoc = await eventDocRef.get();

    if (eventDoc.exists) {
        const eventData = eventDoc.data();
        if (eventData && eventData.hostSocketId) {
            delete hostSocketToEventCode[eventData.hostSocketId];
        }
        // Delete the event document from Firestore
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
    // If this host was previously running an event, end it first.
    const existingEventCode = hostSocketToEventCode[socket.id];
    if (existingEventCode) {
      await endEvent(existingEventCode);
    }

    const newCode = await generateCode();

    await eventsCollection.doc(newCode).set({
      hostFirebaseId: hostId,
      hostSocketId: socket.id,
      state: 'waiting', // Initial state
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    hostSocketToEventCode[socket.id] = newCode;
    socket.join(newCode);
    socket.emit('hostCode', newCode);

    console.log(`New event created by host ${hostId} (${socket.id}) with code: ${newCode}`);
  });

  socket.on('joinEvent', async ({ eventCode, teamId, teamName, section }) => {
    try {
      const eventDoc = eventsCollection.doc(eventCode);
      const eventSnapshot = await eventDoc.get();

      if (eventSnapshot.exists) {
        const eventData = eventSnapshot.data();

        // Prevent joining if the game is already in progress
        if (eventData.state === 'playing') {
          socket.emit('joinResponse', {
            success: false,
            message: 'This game is already in progress. Please wait for the next round.'
          });
          return;
        }

        socket.join(eventCode);
        console.log(`${teamName} (${teamId}) joined event ${eventCode}`);

        socket.emit('joinResponse', {
          success: true,
          eventCode,
          gameState: eventData.state || 'waiting',
          time: 0
        });

        // Notify the host that a new player has joined
        io.to(eventData.hostSocketId).emit('playerJoined', { teamName, section });

        // Send the current leaderboard to the newly joined player
        const leaderboardSnapshot = await eventDoc.collection('leaderboard').orderBy('time').get();
        const leaderboard = leaderboardSnapshot.docs.map(doc => doc.data());
        socket.emit('leaderboardUpdate', leaderboard);
      } else {
        socket.emit('joinResponse', {
          success: false,
          message: 'Invalid event code.'
        });
      }
    } catch (error) {
      console.error('Error processing joinEvent:', error);
      socket.emit('joinResponse', {
        success: false,
        message: 'Internal server error.'
      });
    }
  });

  socket.on('startGame', async ({ eventCode }) => {
    try {
      const eventDoc = eventsCollection.doc(eventCode);
      const eventSnapshot = await eventDoc.get();

      // Ensure the request is from the actual host of this event
      if (eventSnapshot.exists && eventSnapshot.data().hostSocketId === socket.id) {
        await eventDoc.update({ state: 'playing' });

        io.to(eventCode).emit('gameStateUpdate', { state: 'playing', time: 0 });

        // Start the server-side timer
        let currentTime = 0;
        if (eventTimers[eventCode]) clearInterval(eventTimers[eventCode]); // Clear any old timers
        eventTimers[eventCode] = setInterval(() => {
          currentTime += 100;
          io.to(eventCode).emit('timerUpdate', currentTime);
        }, 100);

        console.log(`Game for event ${eventCode} started by host.`);
      }
    } catch (error) {
      console.error('Error starting game:', error);
    }
  });

  socket.on('restartGame', async ({ eventCode }) => {
    try {
        const eventDoc = eventsCollection.doc(eventCode);
        const eventSnapshot = await eventDoc.get();

        if (eventSnapshot.exists && eventSnapshot.data().hostSocketId === socket.id) {
            console.log(`Restarting game for event ${eventCode}.`);

            // Stop and clear the timer
            if (eventTimers[eventCode]) {
                clearInterval(eventTimers[eventCode]);
                delete eventTimers[eventCode];
            }

            // Reset the event state to 'waiting'
            await eventDoc.update({ state: 'waiting' });

            // Clear the leaderboard for this event
            const leaderboardCol = eventDoc.collection('leaderboard');
            const leaderboardSnapshot = await leaderboardCol.get();
            const batch = db.batch();
            leaderboardSnapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();

            // Notify clients to go back to the waiting state with an empty leaderboard
            io.to(eventCode).emit('gameStateUpdate', { state: 'waiting' });
            io.to(eventCode).emit('leaderboardUpdate', []);
            io.to(eventCode).emit('timerUpdate', 0);
        }
    } catch (error) {
        console.error('Error restarting game:', error);
    }
});


  socket.on('endEvent', async ({ eventCode }) => {
    try {
      const eventDoc = eventsCollection.doc(eventCode);
      const eventSnapshot = await eventDoc.get();

      if (eventSnapshot.exists && eventSnapshot.data().hostSocketId === socket.id) {
        await endEvent(eventCode);
        console.log(`Event ${eventCode} ended by host.`);
      }
    } catch (error) {
      console.error('Error ending event:', error);
    }
  });

  socket.on('submitTime', async ({ eventCode, teamId, teamName, section, time }) => {
    const scoreData = {
      name: teamName,
      section: section,
      time: time,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    try {
      const eventDoc = eventsCollection.doc(eventCode);
      await eventDoc.collection('leaderboard').doc(teamId).set(scoreData);

      // Fetch the updated leaderboard and broadcast it to everyone in the event
      const leaderboardSnapshot = await eventDoc.collection('leaderboard').orderBy('time').get();
      const leaderboard = leaderboardSnapshot.docs.map(doc => doc.data());
      io.to(eventCode).emit('leaderboardUpdate', leaderboard);
    } catch (error) {
      console.error('Error saving score or fetching leaderboard:', error);
    }
  });

  socket.on('disconnect', async () => {
    console.log(`User disconnected: ${socket.id}`);
    // If the disconnected user was a host, end their event
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
