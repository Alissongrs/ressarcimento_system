const $ = (id) => document.getElementById(id);

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

// login do portal Claro guardado por versões antigas: apaga (o módulo Claro saiu na 1.5.0)
chrome.storage.local.remove(['claroUsuario', 'claroSenha', 'claroBase']);
