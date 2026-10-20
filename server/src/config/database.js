import mongoose from 'mongoose';

export async function connectMongo(uri) {
  mongoose.set('strictQuery', true);
  return mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
}
