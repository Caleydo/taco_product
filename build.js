/**
 * Created by Samuel Gratzl on 28.11.2016.
 */

const Promise = require('bluebird');
const path = require('path');
const resolve = path.resolve;
const fs = require('fs');
const mkdirp = Promise.promisifyAll(require('mkdirp'));
const chalk = require('chalk');

function toRepoUrl(url) {
  return url.startsWith('http') ? url : `https://github.com/${url}`;
}

function spawn(cmd, args, opts) {
  const spawn = require('child_process').spawn;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);

    p.stdout.on('data', (data) => {
      console.log(chalk.grey(data));
    });

    p.stderr.on('data', (data) => {
      console.error(calk.red(data));
    });

    p.on('close', (code) => {
      code == 0 ? resolve() : reject(code);
    });
  });
}

function npm(cwd, cmd) {
  console.log('running npm', cmd);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawn(npm, (cmd || 'install').split(' '), {
    cwd: cwd
  });
}

function yo(generator, cwd) {
  const yeoman = require('yeoman-environment');
  // call yo internally
  const env = yeoman.createEnv([], {
    cwd: cwd
  });
  env.register(require.resolve('geneator-phovea/generators/' + generator), 'phovea:' + generator);
  return new Promise((resolve, reject) => {
    try {
      console.log('running yo phovea:' + generator);
      env.run('phovea:' + generator, resolve);
    } catch (e) {
      console.error('error', e, e.stack);
      reject(e);
    }
  });
}

function cloneRepo(p, cwd) {
  console.log(`running git clone -b ${p.branch || 'master'} ${toRepoUrl(p.repo)}`);
  return spawn('git', ['clone', '-b', p.branch || 'master', toRepoUrl(p.repo)], {
    cwd: cwd
  });
}

function buildWebApp(p, dir) {
  p.additional = p.additional || [];
  const hasAdditional = p.additional.length > 0;
  const name = p.name;
  console.log(chalk.blue('Building web application:'), p.name);
  let act = spawn('rm', ['-rf', dir])
      .then(() => mkdirp.mkdirpAsync(dir))
      .then(() => cloneRepo(p, dir));
  if (hasAdditional) {
    act = act
        .then(Promise.all(p.additional.map((pi) => cloneRepo(pi, cwd))))
        .then(() => yo('ueber', dir))
        .then(() => npm(dir, 'install'));
  } else {
    act = act
        .then(() => npm(dir + '/' + name, 'install'))
        .then(() => npm(dir + '/' + name, 'run dist'));
  }
  act.catch((error) => {
    console.error('ERROR');
    console.trace(error);
  });
}

function buildApiApp(p) {

}

function buildServiceApp(p) {

}

if (require.main === module) {
  const descs = require('./phovea_product');
  descs.forEach((d, i) => {
    switch (d.type) {
      case 'web':
        return buildWebApp(d, './tmp' + i);
      case 'api':
        return buildApiApp(d, './tmp' + i);
      case 'service':
        return buildServiceApp(d, './tmp' + i);
      default:
        console.error('unknown product type:', d.type);
    }
  });
}
/*
 algorithm:
 mkdir build
 for app of web:
 mkdir app
 cd app
 clone -b app.branch app.repo
 for extra of additional:
 clone -b extra.branch extra.repo
 yo phovea:ueber -v=virtualenv
 npm install
 if app.hybrid:
 npm run build:web:app
 else
 npm run build:app
 mv app/build/* ../build/app
 cd ..
 rm -r app
 for app in api:
 mkdir app
 cd app
 clone -b app.branch app.repo
 for extra of additional:
 clone -b extra.branch extra.repo
 cd ..
 */