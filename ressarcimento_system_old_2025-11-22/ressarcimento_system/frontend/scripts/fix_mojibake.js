/**
 * Normaliza acentuação quebrada (mojibake) em arquivos de UI.
 *
 * - Varre ./src por arquivos .js/.jsx/.ts/.tsx
 * - Aplica substituições comuns (Ã§->ç, Ã£->ã, etc.)
 * - Escreve o arquivo somente quando há mudança
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'src');
const exts = new Set(['.js', '.jsx', '.ts', '.tsx']);

// Mapa de substituições comuns (mojibake UTF-8->Latin1)
const repl = [
  [/Movimenta..es das .ltimas 24h/g, 'Movimentações das últimas 24h'],
  [/Nenhuma movimenta..o registrada nas .ltimas 24 horas\./g, 'Nenhuma movimentação registrada nas últimas 24 horas.'],
  [/Falha ao carregar movimenta..es\./g, 'Falha ao carregar movimentações.'],
  [/Coment. rio:/g, 'Comentário:'],

  [/Ã§/g, 'ç'],
  [/Ã�/g, 'Á'],
  [/Ã‰/g, 'É'],
  [/ÃŠ/g, 'Ê'],
  [/Ã“/g, 'Ó'],
  [/Ã”/g, 'Ô'],
  [/Ã•/g, 'Õ'],
  [/Ãœ/g, 'Ü'],
  [/Ã€/g, 'À'],
  [/Ã‚/g, 'Â'],
  [/Ãƒ/g, 'Ã'],
  [/Ã„/g, 'Ä'],
  [/ÃŒ/g, 'Ì'],
  [/Ã�/g, 'Í'],
  [/ÃŽ/g, 'Î'],
  [/Ã™/g, 'Ù'],
  [/Ãš/g, 'Ú'],
  [/Ã±/g, 'ñ'],
  [/Ã‘/g, 'Ñ'],

  [/Ã¡/g, 'á'],
  [/Ã¢/g, 'â'],
  [/Ã£/g, 'ã'],
  [/Ã¤/g, 'ä'],
  [/Ã©/g, 'é'],
  [/Ãª/g, 'ê'],
  [/Ã­/g, 'í'],
  [/Ã³/g, 'ó'],
  [/Ã´/g, 'ô'],
  [/Ãµ/g, 'õ'],
  [/Ãº/g, 'ú'],
  [/Ã¼/g, 'ü'],
  [/Ã¿/g, 'ÿ'],

  [/�/g, '—'], // replacement char -> em dash (melhor que lixo)
];

function* walk(dir) {
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const d of list) {
    if (d.name === 'node_modules' || d.name === 'dist' || d.name.startsWith('.')) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      yield* walk(full);
    } else if (exts.has(path.extname(d.name))) {
      yield full;
    }
  }
}

let changed = 0;
for (const file of walk(root)) {
  let data = fs.readFileSync(file, 'utf8');
  let out = data;
  for (const [re, to] of repl) out = out.replace(re, to);
  if (out !== data) {
    fs.writeFileSync(file, out, 'utf8');
    changed++;
    console.log('[fix]', path.relative(root, file));
  }
}
console.log(`Done. Files changed: ${changed}`);

