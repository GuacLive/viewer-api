import {createAdapter} from '@socket.io/redis-adapter';
import 'dotenv/config'; // see https://github.com/motdotla/dotenv#how-do-i-use-dotenv-with-import
import * as express from 'express';
import {createServer, Server} from 'http';
import {createClient} from 'redis';
import * as socketIo from 'socket.io';
import {ChannelEvent, PlaybackEvent} from './constants';
import {Channel} from './types';
// @ts-ignore
var cors = require('cors');

export type RedisClientType = ReturnType<typeof createClient>;

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const pubClient: RedisClientType = createClient({
	url: REDIS_URL,
});
const subClient = pubClient.duplicate();

const VIEWER_API_KEY = process.env.VIEWER_API_KEY;

export class ViewerServer {
    public static readonly PORT: number = 3003;
    private _app: express.Application;
    private server: Server;
    private io: socketIo.Server;
    private port: string | number;

    constructor() {
        this._app = express();
        this.port = process.env.PORT || ViewerServer.PORT;
        this._app.use(cors());
        this._app.use(express.json());
        this._app.options('*', cors());

        this._app.get('/viewers', async(_req, res) => {
            const rooms = await this.io.of('/playback').adapter.rooms;
            const clients = await this.io.of('/playback').sockets;
            const roomsWithViewers = await Promise.all(
                [...rooms].map(async ([room, sockets]): Promise<{username: string; viewers: number} | null> => {
                    const isPrivate = sockets.size === 1 && sockets.has(room);
                    if(!isPrivate) {
                        return Promise.resolve({
                              username: room,
                             viewers: sockets.size
                         });
                    } else {
                        return Promise.resolve(null);
                    }
                })
            );

            res.send({
                rooms: roomsWithViewers.filter(a => !!a).sort((a, b) => b.viewers - a.viewers),
                total_connections: clients.size
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
        this._app.post('/admin', async(req, res) => {
            console.log('auth', req.headers.authorization);
            if(!req.headers.authorization || !VIEWER_API_KEY || req.headers.authorization !== VIEWER_API_KEY){
                return res.status(403).json({statusCode: 403, error: 'Invalid credentials sent!'});
            }
            if(!req.body.name){
                return res.status(400).json({statusCode: 400, error: 'Invalid request!'});
            }
            switch (req.body.action) {
                case 'live':
                    if(this.io){
                        this.io.of('/channel').in(req.body.name).emit('live', req.body.live || false);
                    }
                    res.sendStatus(200);
                    return;
                case 'event':
                    if(this.io){
                        if(!req.body.name) return res.sendStatus(500);
                        if(!req.body.event || !req.body.event.message) return res.sendStatus(500);
                        this.io.of('/channel').in(req.body.name).emit('event', {
                            channel: {name: req.body.name},
                            event: req.body.event
                        });
                    }
                    res.sendStatus(200);
                    return;
                case 'reload':
                    if(this.io){
                        this.io.of('/channel').in(req.body.name).emit('reload');
                    }
                    res.sendStatus(200);
                    return;
                case 'redirect':
                    if(this.io){
                        this.io.of('/channel').in(req.body.name).emit('redirect', req.body.url);
                    }
                    res.sendStatus(200);
                    return;
            }
            res.sendStatus(500);
        });
        this.server = createServer(this._app);
        this.initSocket();
        this.listen();
    }

    private initSocket(): void {
        this.io = require('socket.io')(this.server, {
            wsEngine: require("eiows").Server,
            cors: {
                origin: true,
                methods: ['GET', 'POST'],
                credentials: true
            },
            perMessageDeflate: {
                threshold: 32768
            }
        });
        // @ts-expect-error
		this.io.adapter(createAdapter(pubClient, subClient));
    }

    private async getViewerCount(c: Channel) {
        return await new Promise<number>(async (resolve: Function, /*reject: Function*/) => {
            if(!c || !c.name) resolve(0);
            const clients = await this.io
                .of('/playback')
                .adapter
                // @ts-ignore
                .sockets(new Set([c.name]));
            let clientCount = clients.size;
            resolve(clientCount);
        });
    }

    private emitViewerCount(socket: socketIo.Socket): void {
        var roomKeys: Set<string> = new Set(socket.rooms);
        roomKeys.delete(socket.id);
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

     private async listen(): Promise<void> {
		let promises: any[] = [];
		promises = [pubClient.connect(), subClient.connect()];

		return Promise.all(promises).then(() => {
            this.server.listen(this.port, () => {
                console.log('[guac.live]', `Running viewer server on port ${this.port}`);
            });

            this.io
            .of('/channel')
            .on(ChannelEvent.CONNECT, (socket: socketIo.Socket) => {
                console.log('[guac.live]', `Connected channel client on port ${this.port}`);

                socket.on(ChannelEvent.JOIN, (c: Channel) => {
                    if(!c || !c.name) return socket.disconnect();
                    console.log('[server](channel): join %s', JSON.stringify(c));
                    socket.join(c.name);
                });

                socket.on(ChannelEvent.EVENT, (c: Channel, e: Event) => {
                    if(!c || !c.name) return socket.disconnect();
                    socket.in(c.name).emit('event', {
                        channel: c.name,
                    ...e
                    });
                });

                socket.on(ChannelEvent.LEAVE, async (c: Channel) => {
                    if(!c || !c.name) return socket.disconnect();
                    console.log('[server](channel): leave %s', JSON.stringify(c));
                    socket.leave(c.name);
                });

                socket.on(ChannelEvent.DISCONNECT, () => {
                    console.log('[guac.live]', 'Channel client disconnected');
                    //socket.leaveAll();
                });
            });

            this.io
            .of('/playback')
            .on(PlaybackEvent.CONNECT, (socket: socketIo.Socket) => {
                console.log('[guac.live]', `Connected playback client on port ${this.port}`);

                socket.on(PlaybackEvent.JOIN, (c: Channel) => {
                    if(!c || !c.name) return socket.disconnect();
                    console.log('[server](playback): join %s', JSON.stringify(c));
                    socket.join(c.name);
                    this.emitViewerCount(socket);
                });

                socket.on(PlaybackEvent.SET, (c: string) => {
                    socket.emit(PlaybackEvent.SET, c);
                })

                socket.on(PlaybackEvent.LEAVE, async (c: Channel) => {
                    if(!c || !c.name) return socket.disconnect();
                    console.log('[server](playback): leave %s', JSON.stringify(c));
                    socket.leave(c.name);
                    console.log(await this.getViewerCount(c));
                });

                socket.on(PlaybackEvent.DISCONNECT, () => {
                    console.log('[guac.live]', 'Playback client disconnected');
                    //socket.leaveAll();
                });

                setInterval(() => {return this.emitViewerCount.bind(this)(socket)}, 30 * 1000);
            });
        });
    }

    get app(): express.Application {
        return this._app;
    }
}
