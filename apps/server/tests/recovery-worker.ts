import { startServer } from '../src/http.js';
import { FileRoomStore } from '../src/storage/file-store.js';
let armed: 'before_rename' | 'after_rename' | null = null;
const store = new FileRoomStore(process.env['RICHMAN_DATA_DIR']!, {
  checkpoint: async point => {
    if (point === armed) { process.send?.({type:'barrier',point}); await new Promise(() => {}); }
  },
});
process.on('message', (m: {type:string;point:'before_rename'|'after_rename'}) => {
  if (m.type === 'arm') { armed = m.point; process.send?.({type:'armed'}); }
});
const server = await startServer({host:'0.0.0.0',port:0,store});
process.send?.({type:'ready',port:server.port});
