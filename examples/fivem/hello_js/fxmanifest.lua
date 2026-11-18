fx_version 'cerulean'
game 'gta5'

author 'fxcompat example'
description 'JavaScript twin of the hello example, used to prove the LS:MP migration'
version '1.0.0'

ui_page 'html/index.html'

files {
  'html/index.html',
  'html/style.css',
  'html/script.js',
}

shared_script 'config.js'
client_script 'client.js'
server_script 'server.js'
