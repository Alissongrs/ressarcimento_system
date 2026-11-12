// O módulo "Faturas Claro" foi removido em 12/11/2026 (as faturas da Claro passaram a ser atualizadas à mão).
// Este arquivo continua existindo só porque o background.js o carrega (importScripts('claro_bg.js')):
// ele carrega o módulo "Registrar na ANEEL".
importScripts('registro_bg.js');

// apaga o login do portal Claro que versões antigas guardaram neste computador
chrome.storage.local.remove(['claroUsuario', 'claroSenha', 'claroBase', 'jobClaro']);
