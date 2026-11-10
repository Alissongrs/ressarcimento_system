const $ = (id) => document.getElementById(id);
const BASE_PADRAO = 'https://clarobps-pdp.azurewebsites.net';

chrome.storage.local.get(['claroUsuario', 'claroSenha', 'claroBase'], (v) => {
  $('usuario').value = v.claroUsuario || '';
  $('senha').value = v.claroSenha ? '********' : '';
  $('base').value = v.claroBase || BASE_PADRAO;
});

$('salvar').onclick = () => {
  const dados = { claroUsuario: $('usuario').value.trim(), claroBase: ($('base').value.trim() || BASE_PADRAO).replace(/\/+$/, '') };
  if ($('senha').value && $('senha').value !== '********') dados.claroSenha = $('senha').value;
  chrome.storage.local.set(dados, () => { $('ok').textContent = 'Salvo.'; setTimeout(() => { $('ok').textContent = ''; }, 2000); });
};

chrome.storage.local.get(['aneelUsuario', 'aneelSenha'], (v) => {
  $('aneelUsuario').value = v.aneelUsuario || '';
  $('aneelSenha').value = v.aneelSenha ? '********' : '';
});

$('aneelSalvar').onclick = () => {
  const dados = { aneelUsuario: $('aneelUsuario').value.trim() };
  if ($('aneelSenha').value && $('aneelSenha').value !== '********') dados.aneelSenha = $('aneelSenha').value;
  chrome.storage.local.set(dados, () => { $('aneelOk').textContent = 'Salvo.'; setTimeout(() => { $('aneelOk').textContent = ''; }, 2000); });
};

$('aneelApagar').onclick = () => {
  chrome.storage.local.remove(['aneelUsuario', 'aneelSenha'], () => {
    $('aneelUsuario').value = ''; $('aneelSenha').value = '';
    $('aneelOk').textContent = 'Login apagado.';
  });
};

$('apagar').onclick = () => {
  chrome.storage.local.remove(['claroUsuario', 'claroSenha'], () => {
    $('usuario').value = ''; $('senha').value = '';
    $('ok').textContent = 'Login apagado.';
  });
};
