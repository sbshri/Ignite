#!/usr/bin/env node

import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import opn from 'opn';

import history from 'connect-history-api-fallback';
import convert from 'koa-connect';
import git from 'simple-git/promise';
import dayjs from 'dayjs';
import globby from 'globby';
import register from '@babel/register';
import root from 'root-path';
import cosmiconfig from 'cosmiconfig';
import webpack from 'webpack';
import serve from 'webpack-serve';
import ghpages from 'gh-pages';
import webpackServeWaitpage from 'webpack-serve-waitpage';

import config from '../webpack.config';
import { transform } from './loaders/hash-link';
import createStaticSite from './create-static-site';
import defaults from './default-config';
import printError from './utils/print-error';

export function initPlugins(options) {
  register();

  options.plugins.forEach(async plugin => {
    let [, pluginPath, pluginOptions] = plugin;
    const pluginPackage = path.join(pluginPath, 'package.json');
    let initFile;

    if (!pluginOptions) {
      pluginOptions = {};
      plugin[2] = pluginOptions;
    }

    try {
      initFile = path.join(pluginPath, require(pluginPackage).init);
    } catch (error) {
      initFile = path.resolve(path.join(pluginPath, 'init.js'));
    }

    try {
      const initFunction = require(initFile);

      pluginOptions._initData = await (initFunction.default
        ? initFunction.default(pluginOptions)
        : initFunction(pluginOptions));

      if (initFunction.injectComponents) {
        pluginOptions._injectedComponents = `
            {
              ${Object.entries(initFunction.injectComponents(pluginOptions))
                .map(([name, componentPath]) => {
                  return `'${name}': require('${path.resolve(componentPath)}')`;
                })
                .join(',')}
            }
          `;
      }
    } catch (error) {
      // No Init function found
    }
  });

  return options;
}

export async function initBlogPosts(options) {
  let blogPosts = await globby([path.join(options.src, 'blog/**/*.md')]);

  if (blogPosts.length === 0) {
    return null;
  }

  blogPosts = await Promise.all(
    blogPosts
      .map(blogFile => path.relative(options.src, blogFile))
      .map(async blogFile => {
        try {
          const docLog = await git().log({
            file: path.join(options.src, blogFile)
          });
          const birth = docLog.all[docLog.all.length - 1].date;
          return {
            path: blogFile,
            birth: Number(dayjs(birth))
          };
        } catch (error) {
          printError(error);

          return {
            path: blogFile
          };
        }
      })
  );

  return blogPosts.sort((a, b) => a.birth > b.birth);
}

export function getAuthor(pkgJson) {
  const rootJson =
    pkgJson || JSON.parse(fs.readFileSync(`${root()}/package.json`));
  let author = rootJson ? rootJson.author : {};

  if (typeof author === 'string') {
    // Stolen from https://stackoverflow.com/a/14011481
    const regexParseMatch = author.match(
      /(?:"?([^"]*)"?\s)?(?:<?(.+@[^>]+)>?)/
    );
    if (regexParseMatch) {
      author = {
        name: regexParseMatch[1],
        email: regexParseMatch[2]
      };
    }
  }

  return author;
}

export function initBuildMessages(options) {
  if (options.watch) {
    options = Object.assign({}, options, {
      mode: 'development',
      compilationSuccessInfo: {
        messages: [
          `You documentation is running here http://localhost:${options.port}`
        ]
      }
    });
  } else {
    options = Object.assign({}, options, {
      compilationSuccessInfo: {
        messages: ['Documentation built!'],
        notes: [
          `Bundled documentation stored in '${options.dst}'.`,
          'Run `ignite --publish` to publish documentation to github-pages.'
        ]
      }
    });
  }

  return options;
}

function publish(options, user) {
  if (options.githubURL.includes('http')) {
    [, options.githubURL] = options.githubURL.split('//');
  }

  // If a fqdn is set, write to the CNAME file
  if (options.fqdn) {
    fs.writeFileSync(
      path.join(options.dst, options.baseURL, 'CNAME'),
      `${options.fqdn}\n`
    );
  }

  ghpages.publish(
    path.join(options.dst, options.baseURL),
    {
      message: ':memo: Update Documentation [skip ci]',
      repo: `https://username:${process.env.GH_TOKEN}@${options.githubURL}`,
      user
    },
    err => {
      if (err) {
        printError(err);

        return;
      }

      console.warn('Documentation published to github-pages!');
    }
  );
}

export async function initSearchIndex(options) {
  const entries = await globby([path.join(options.src, '**/*.md')]);
  const files = [];

  entries.forEach(entry => {
    const pageContents = fs.readFileSync(entry, 'utf8');
    const pagePath = path.relative(options.src, entry);

    files.push({
      id: pagePath,
      body: transform(pageContents, entry, options)
    });
  });

  return files.sort((a, b) => a.id > b.id);
}

export async function initOptions(options) {
  const explorer = cosmiconfig('ignite');
  const igniteRc = explorer.searchSync(options.src);
  options = Object.assign({}, defaults, options);

  if (igniteRc) {
    options = Object.assign({}, options, igniteRc.config);
  }

  if (options.baseURL.includes('http')) {
    // Extract the fqdn from the baseURL
    const [, fqdn] = options.baseURL.match(/^https?:\/\/([^/?#]+)(?:[/?#]|$)/i);
    options = Object.assign({}, options, {
      fqdn
    });
  }

  // If fqdn is set, remove it from the baseURL
  const baseURL = options.fqdn
    ? options.baseURL.split(options.fqdn)[1]
    : options.baseURL;

  options = Object.assign({}, options, {
    baseURL: options.watch ? '/' : path.join('/', baseURL, '/')
  });

  options = initBuildMessages(options);
  options.blogPosts = await initBlogPosts(options);
  options.searchIndex = await initSearchIndex(options);

  if (options.plugins) {
    const pluggedOptions = await initPlugins(options);
    options = pluggedOptions;
  }

  if (options.navItems) {
    Object.entries(options.navItems).forEach(([key, val]) => {
      options.navItems[key] = path.join(options.baseURL, val);
    });
  }

  return options;
}

export default async function build(options) {
  const user = getAuthor();

  const finalOptions = await initOptions(options);
  const webpackConfig = config(finalOptions);

  if (finalOptions.publish) {
    if (!finalOptions.githubURL) {
      printError('Need to provide githubURL option to publish');
      return;
    }

    if (!user.name) {
      printError('Need author.name in package.json to publish');
      return;
    }

    if (!user.email) {
      printError('Need author.email in package.json to publish');
      return;
    }
  }

  if (finalOptions.watch) {
    return serve(
      {
        logLevel: 'silent'
      },
      {
        config: webpackConfig,
        port: finalOptions.port,
        add: (app, middleware, finalOptions) => {
          app.use(
            webpackServeWaitpage(finalOptions, {
              title: 'Ignite Dev Server',
              theme: 'material'
            })
          );

          app.use(
            convert(
              history({
                ...webpackConfig.devServer.historyApiFallback
              })
            )
          );
        },
        on: {
          listening: () => {
            if (finalOptions.open) {
              const url = encodeURI(`http://localhost:${finalOptions.port}`);
              try {
                execSync('ps cax | grep "Google Chrome"');
                execSync(`osascript ../src/chrome.applescript "${url}"`, {
                  cwd: __dirname,
                  stdio: 'ignore'
                });
              } catch (error) {
                opn(url);
              }
            }
          }
        }
      }
    );
  }

  const compiler = webpack(webpackConfig);

  return new Promise((resolve, reject) =>
    compiler.run(async (err, stats) => {
      if (finalOptions.json) {
        fs.writeFile(
          'stats.json',
          JSON.stringify(stats.toJson(), null, 2),
          () => console.warn('Wrote `stats.json` to root.')
        );
      }
      if (err) {
        printError(err);

        if (err.details) {
          printError(err.details);
        }

        return reject();
      }

      stats.hasWarnings();

      if (stats.hasErrors()) {
        return;
      }

      if (finalOptions.static) {
        await createStaticSite(finalOptions);
      }

      if (finalOptions.publish) {
        publish(finalOptions, user);
      }

      resolve();
    })
  );
}
