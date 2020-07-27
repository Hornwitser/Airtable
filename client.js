"use strict";
const WebSocket = require("ws");
const fs = require("fs").promises;
const { started_game, stopped_game } = require('./airtable.js');
const { lua_array, print_error } = require('./helpers.js');


let servers;
let websocket;
let lobby_ip;
exports.init = async function(config, init_servers, base, file_events, rcon_events) {
    servers = init_servers;

    for (let server of servers.values()) {
        if (server.is_lobby === true) {
            throw new Error('Client cannot have the lobby server');
        }
    }

    rcon_events.on("connect", function(ip, server) {
        server_connected(ip, server).catch(print_error(`setting up rcon connection to ${ip}:`));
    });

    rcon_events.on("close", function(ip, server) {
        server_disconnected(ip, server);
        console.log(`lost rcon connection with ${ip}`);
    });

    file_events.on("started_game", function(server, event) {
        console.log(event);
        started_game(base, event.name, lua_array(event.players)).then(record_id => {
            server.record_id = record_id;
        }).catch(print_err("calling started_game"));
    });

    file_events.on("stopped_game", async function(server, event) {
        if (server.record_id) {
            let record_id = server.record_id;
            server.record_id = null;
            await stopped_game(base, lua_array(event.results), record_id);

        } else {
            console.log(`Received stopped_game, but missing airtable record_id`);
            console.log(JSON.stringify(event));
        }
        setTimeout(async function() {
            await server.rcon.send("/lobby_all");
        }, 10000);

        //In 20 sec kick all players
        setTimeout(async function() {
            await server.rcon.send("/kick_all");
        }, 20000);

        websocket.send(JSON.stringify(event));
    });

    //Load tls certificate for websocket connection if it is configured
    let cert = config.tls_cert_file ? await fs.readFile(config.tls_cert_file) : null;
    connect_websocket(config.ws_url, config.ws_token, cert);
};

//Handle rcon connection established with a Factorio server
async function server_connected(ip, server) {
    if (server.is_lobby) {
        throw new Error("Client cannot have the lobby server");
    }

    //Ensure the server knows it is not the lobby.
    await server.rcon.send(`/set_lobby false`);

    //Set the ip of the lobby if available
    if (lobby_ip !== undefined) {
        await server.rcon.send(`/interface global.servers = {lobby = '${lobby_ip}'}`);
    }

    //Get all mini games the server can run
    let result = await server.rcon.send(`/interface return game.table_to_json(mini_games.available)`);

    //Remove the command complete line
    result = result.split('\n')[0];
    server.games = lua_array(JSON.parse(result));
    server.online = true;
    send_server_list();
}

function server_disconnected(ip, server) {
    server.online = false;
    send_server_list();
}

function send_server_list() {
    let server_list = {};
    for (let [ip, server] of servers) {
        if (server.online) {
            server_list[ip] = {
                "games": server.games || [],
            };
        }
    }

    websocket.send(JSON.stringify({ "type": 'server_list', "servers": server_list }));
}


//setup connection to the websocket interface of the server
function connect_websocket(url, token, cert) {
    let options = {
        headers: { "Authorization": token },
    };
    if (cert) {
        options.ca = cert;
    }
    if (/(\d+\.){3}\d+/.test(new URL(url).hostname)) {
        //Overzealous ws lib adds SNI for IP hosts.
        options.servername = "";
    }
    let ws = new WebSocket(url, options);
    ws.on("open", function() {
        //empty
    });
    ws.on("message", function(message) {
        on_message(JSON.parse(message)).catch(print_error(`on_message(${message.type}) failed`));
    });
    ws.on("error", function(error) {
        console.error("WebSocket connection error:", error.message);
    });
    ws.on("close", function() {
        console.log("WebSocket connection lost, reconnecting in 10 seconds");
        setTimeout(function() {
            connect_websocket(url, token, cert);
        }, 10000);
    });
    websocket = ws;
}

//Invoked when a message is received from the WebSocket server.
async function on_message(message) {
    console.log(`data recieved: ${JSON.stringify(message, null, 4)}`);

    if (message.type === 'start_game') {
        let server = servers.get(message.server);
        if (server && server.rcon.authenticated) {
            await server.rcon.send(`/start ${message.name} ${message.player_count} ${message.args.join(' ')}`);
        } else {
            console.log(`Received start for unavailable server ${message.server}`);
        }

    } else if (message.type === 'connected') {

        //Update main server's list of server
        send_server_list();

        //Update stored lobby ip
        lobby_ip = message.lobby_ip;

        //loop over all the local server and set the lobby
        for (let server of servers.values()) {
            if (server.rcon.authenticated) {
                await server.rcon.send(`/interface global.servers = {lobby = '${lobby_ip}'}`);
            }
        }

    } else {
        console.log(`Unkown type ${data.type}`);
    }
}