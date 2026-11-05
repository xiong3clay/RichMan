import { FileRoomStore } from '../storage/file-store.js';
import { RoomManager } from './manager.js';
export async function loadAllRooms(store: FileRoomStore, manager = new RoomManager()): Promise<RoomManager> {
  for (const snapshot of await store.loadAll()) manager.restoreRoom(snapshot);
  manager.setStore(store);
  return manager;
}
