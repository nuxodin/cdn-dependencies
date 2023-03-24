const vscode = require('vscode');
const fs = require('fs');

const githubCdns = [
	'https://cdn.jsdelivr.net/gh/',
	'http://gcdn.li/',
];
const npmCdns = [
	'https://cdn.jsdelivr.net/npm/',
	'https://unpkg.com/',
	//'https://cdnjs.cloudflare.com/ajax/libs/',
	//'https://cdn.skypack.dev/',
	//'https://cdn.pika.dev/',
];

function activate(context) {
	console.log('"cdn-dependencies" is now active!');
	//console.log('context.extensionPath', context.extensionPath);
	//console.log('context.globalStoragePath', context.globalStoragePath);

	let disposable = vscode.commands.registerCommand('cdn-dependencies.check-workspace', checkWorkspace);
	context.subscriptions.push(disposable);

	let activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		decorateEditor(activeEditor);
	}
}
function deactivate() {}

module.exports = {
	activate,
	deactivate,
}

vscode.workspace.onDidOpenTextDocument((document) => {
	decorateEditor(vscode.window.activeTextEditor);
});
vscode.workspace.onDidSaveTextDocument((document) => {
	decorateEditor(vscode.window.activeTextEditor);
});



function documentFindOutdatedImports(document) {
	const findings = [];
	document.getText().split('\n').forEach( async (line, lineNumber) => {
		for (const cdn of githubCdns) {

			if (line.indexOf(cdn) === -1) continue;
			const match = line.match(new RegExp(regEscape(cdn) + '([^\/]+)\/([^\/]+)@([^\/]+)\/'));

			if (match) {
				const [url, user, repo, version] = match;
				if (!version) return;
				if (version === 'main') return;
				if (version[0] === 'x') return;
				if (user[0] === '$') return;
				if (repo[0] === '$') return;
				const nVersion = await getGithubVersion(user, repo);
				if (!nVersion) return;
				if (nVersion === version) return;

				// find the start index and the end index of the version part
				const versionMatch = url.match(/@([^\/]+)\//);
				const colStart = versionMatch.index + 1 + match.index;
				const colEnd = colStart + versionMatch[1].length;

				const range = new vscode.Range(lineNumber, colStart, lineNumber, colEnd);
				findings.push({document, range, url, version, nVersion });
			}
		}
		for (const cdn of npmCdns) {

			if (line.indexOf(cdn) === -1) continue;
			const match = line.match(new RegExp(regEscape(cdn) + '([^\/]+)@([^\/]+)\/'));

			if (match) {
				const [url, packageName, version] = match;
				if (!version) return;
				// if (version === 'main') return;
				const nVersion = await getNpmVersion(packageName);
				if (!nVersion) return;
				if (nVersion === version) return;

				// find the start index and the end index of the version part
				const versionMatch = url.match(/@([^\/]+)\//);
				const colStart = versionMatch.index + 1 + match.index;
				const colEnd = colStart + versionMatch[1].length;

				const range = new vscode.Range(lineNumber, colStart, lineNumber, colEnd);
				findings.push({document, range, url, version, nVersion });
			}
		}
	});
	return findings;
}

async function checkUri(uri) {
	const textDocument = await vscode.workspace.openTextDocument(uri);
	const findings = await documentFindOutdatedImports(textDocument);
	findings.forEach((finding) => {
		const message = `Neu versionen in ${uri.fsPath}:\n ${finding.url} -> ${finding.nVersion}`;
		vscode.window.showInformationMessage(message, 'Go')
			.then((selection) => {
				if (selection === 'Go') {
					const fileUri = vscode.Uri.file(uri.fsPath);
					vscode.window.showTextDocument(fileUri, {selection: finding.range});
				}
			});
	});
}

async function decorateEditor(editor) {
	if (!editor) return;
	const document = editor.document;
	const findings = await documentFindOutdatedImports(document);
	const ranges = findings.map((finding) => {
		const range = finding.range;
		const decoration = {
			range: range,
			hoverMessage: 'Newest: ' + finding.nVersion,
		};
		return decoration;
	});
	editor.setDecorations(invalidImportDecorationType, ranges);
}

async function checkWorkspace(){
	vscode.workspace.findFiles('**/*').then(uriArray => {
		uriArray.forEach(uri => {
			if (!uri.fsPath.match(/\.(js|css|html)$/)) return;
			checkUri(uri);
		});
	});
}



/* version cache */
function getGithubVersion(user, repo) {
	return getVersionCache('github', user+'/'+repo, async () => {
		// const {default: fetch} = await import('node-fetch');
		// const release = await fetch(`https://api.github.com/repos/${user}/${repo}/releases/latest`, {method:'GET'}).then(res=>res.json());
		try {
			const release = await xGet(`https://api.github.com/repos/${user}/${repo}/releases/latest`);
			if (!release) return;
			if (!release.tag_name) return;
			const version = release.tag_name.replace('v', '');
			return version;
		} catch (e) { console.log(`failed https://api.github.com/repos/${user}/${repo}/releases/latest`, e.message); return false; }
	});
}
function getNpmVersion(packageName) {
	return getVersionCache('npm', packageName, async () => {
		// const {default: fetch} = await import('node-fetch');
		// const release = await fetch(`https://registry.npmjs.org/${packageName}/latest`).then(res=>res.json());
		try {
			const release = await xGet(`https://registry.npmjs.org/${packageName}/latest`);
			if (!release) return;
			if (!release.version) return;
			return release.version;
		} catch (e) { console.log(`failed: https://registry.npmjs.org/${packageName}/latest`, e.message); return false; }
	});
}

const versionCache = {};
async function getVersionCache(pManager, id, getRemote) {
	if (!versionCache[pManager]) {
		if (fs.existsSync('versionCache.json')) {
			versionCache[pManager] = JSON.parse(fs.readFileSync('cache-'+pManager+'.json'));
		} else {
			versionCache[pManager] = {};
		}
	}
	const cache = versionCache[pManager];
	if (cache[id]) {
		if (cache[id].timestamp > Date.now() - 1000*60*60*24) { // 24h
			return cache[id].version;
		}
	}
	// get remote version
	const version = await getRemote();
	if (!version) return;
	// save to local cache
	if (!cache[id]) cache[id] = {};
	cache[id].version = version;
	cache[id].timestamp = Date.now();

	// save to file
	fs.writeFileSync('cache-'+pManager+'.json', JSON.stringify(cache));
	return version;
}


const invalidImportDecorationType = vscode.window.createTextEditorDecorationType({
	textDecoration: 'underline wavy orange',
});


function regEscape(str) {
	return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}




const https = require('https')

function xxGet(url, data) {
  const dataString = JSON.stringify(data)
  const options = {
    //method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      //'Content-Length': dataString.length,
    },
    timeout: 1000, // in ms
  }

  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      if (res.statusCode < 200 || res.statusCode > 299) {
        return reject(new Error(`HTTP status code ${res.statusCode}`))
      }
      const body = [];
      res.on('data', (chunk) => body.push(chunk))
      res.on('end', () => {
        const resString = Buffer.concat(body).toString();
		const obj = JSON.parse(resString);
        resolve(obj)
      })
    })
    req.on('error', (err) => {
      reject(err)
    })
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request time out'))
    })
    //req.write(dataString);
    req.end();
  });
}

function xGet(url) {
	return new Promise((resolve, reject) => {
		https.get(url, function(res){
			var body = '';
			res.on('data', function(chunk){
				body += chunk;
			});
			res.on('end', function(){
				resolve(JSON.parse(body));
			});
		}).on('error', function(e){
			reject(e)
		});
	});
}
