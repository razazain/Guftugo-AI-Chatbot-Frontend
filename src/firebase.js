import { getApps, initializeApp } from 'firebase/app';
import { getAuth, getRedirectResult, GoogleAuthProvider } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
};

export const firebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId,
);

const app = firebaseConfigured
  ? (getApps().find((existing) => existing.name === 'guftugo-web') || initializeApp(firebaseConfig, 'guftugo-web'))
  : null;

export const firebaseAuth = app ? getAuth(app) : null;
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Cache the redirect result promise so React StrictMode's development effect replay
// cannot consume the one-time Firebase redirect result twice.
let redirectResultPromise;
export function getGoogleRedirectResult() {
  if (!firebaseAuth) return Promise.resolve(null);
  if (!redirectResultPromise) redirectResultPromise = getRedirectResult(firebaseAuth);
  return redirectResultPromise;
}
