import * as express from 'express';
import * as socketIo from 'socket.io';
import * as redis from 'socket.io-redis';
import {RedisAdapter} from 'socket.io-redis';
import {ViewerEvent} from './constants';
import {Channel} from './types';
import {createServer, Server} from 'http';
var cors = require('cors');

export class ViewerServer {
    public static readonly PORT: number = 3003;
    private _app: express.Application;
    private server: Server;
    private io: SocketIO.Server;
    private port: string | number;

    constructor() {
        this._app = express();
        this.port = process.env.PORT || ViewerServer.PORT;
        this._app.use(cors());
        this._app.options('*', cors());
        this._app.get('/viewers', async(_req, res) => {
            this.io.of('/playback').clients((error: Error, clients: Array<string>) => {
                if(error) res.status(500).send(error.message);
                res.send({
                    viewers: clients.length
                });
            });
        });
        this._app.get('/viewers/:channel', async(req, res) => {
            console.log(req.params);
            let viewerCount: Number = await this.getViewerCount({
                name: req.params.channel
            });
            res.send({
                viewers: viewerCount
            });
        });
        this.server = createServer(this._app);
        this.initSocket();
        this.listen();
    }

    private initSocket(): void {
        this.io = socketIo(this.server);
        if(process.env.REDIS_URL){
            const adapter: RedisAdapter = redis(process.env.REDIS_URL);
            this.io.adapter(adapter);  
        }  
    }

    private async getViewerCount(c: Channel) {
        return await new Promise<number>((resolve: Function, reject: Function) => {
            if(!c.name) resolve(0);
            this.io
            .of('/playback')
            .in(c.name)
            .clients((error: Error, clients: Array<string>) => {
                if(error) reject(error);
                let clientCount: Number = clients.length;
                resolve(clientCount);
            });
        });
    }

    private emitViewerCount(socket: socketIo.Socket): void {
        var roomKeys: Array<string> = Object.keys(Object.assign({}, socket.rooms));
        var socketIdIndex = roomKeys.indexOf(socket.id);
        roomKeys.splice(socketIdIndex, 1);
        roomKeys.forEach(async (room) => {
            console.log('yes', room);
            socket.emit('viewerCount', {
                channel: room,
                viewers: await this.getViewerCount({
                    name: room
                })
            })
        })
    }

    private listen(): void {
        this.server.listen(this.port, () => {
            console.log('[guac.live]', `Running viewer server on port ${this.port}`);
        });

        this.io
        .of('/playback')
        .on(ViewerEvent.CONNECT, (socket: socketIo.Socket) => {
            console.log('[guac.live]', `Connected playback client on port ${this.port}`);

            socket.on(ViewerEvent.JOIN, (c: Channel) => {
                if(!c.name) socket.disconnect();
                console.log('[server](playback): join %s', JSON.stringify(c));
                socket.join(c.name, () => {
                    this.emitViewerCount(socket);
                });
            });

            socket.on(ViewerEvent.LEAVE, async (c: Channel) => {
                if(!c.name) socket.disconnect();
                console.log('[server](playback): leave %s', JSON.stringify(c));
                socket.leave(c.name);
                console.log(await this.getViewerCount(c));
            });

            socket.on(ViewerEvent.DISCONNECT, () => {
                console.log('[guac.live]', 'Playback client disconnected');
                socket.leaveAll();
            });

            setInterval(() => {return this.emitViewerCount.bind(this)(socket)}, 30 * 1000);
        });
    }

    get app(): express.Application {
        return this._app;
    }
}
