import admin from 'firebase-admin';

let db;

export function initFirebase() {
    if (admin.apps.length > 0) return admin.apps[0];

    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });

    db = admin.firestore();
    console.log('✅ Firebase conectado.');
    return db;
}

export function getDb() {
    if (!db) throw new Error('Firebase não inicializado. Chame initFirebase() primeiro.');
    return db;
}