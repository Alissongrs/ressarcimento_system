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

$('apagar').onclick = () => {
  chrome.storage.local.remove(['claroUsuario', 'claroSenha'], () => {
    $('usuario').value = ''; $('senha').value = '';
    $('ok').textContent = 'Login apagado.';
  });
};
