const fs = require('node:fs');
const path = require('node:path');
const webpack = require('webpack');
const { VueLoaderPlugin } = require('vue-loader');
webpack(
  {
    mode: 'production',
    context: __dirname,
    devtool: false,
    entry: { index: './src/index.ts', demo: './src/demo.ts' },
    output: { path: path.join(__dirname, 'dist'), filename: '[name].js', clean: true },
    resolve: {
      extensions: ['.ts', '.js', '.vue'],
      alias: { vue: require.resolve('vue/dist/vue.runtime.esm-bundler.js') },
    },
    module: {
      rules: [
        { test: /\.vue$/, loader: require.resolve('vue-loader') },
        {
          test: /\.ts$/,
          loader: require.resolve('ts-loader'),
          options: {
            transpileOnly: true,
            appendTsSuffixTo: [/\.vue$/],
            configFile: path.join(__dirname, 'tsconfig.json'),
            compilerOptions: { noEmit: false },
          },
        },
        { test: /\.css$/, use: [require.resolve('vue-style-loader'), require.resolve('css-loader')] },
      ],
    },
    plugins: [
      new VueLoaderPlugin(),
      new webpack.DefinePlugin({
        __VUE_OPTIONS_API__: 'false',
        __VUE_PROD_DEVTOOLS__: 'false',
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
      }),
    ],
    performance: { hints: false },
  },
  (error, stats) => {
    if (error || stats.hasErrors()) {
      console.error(error || stats.toString({ all: false, errors: true }));
      process.exitCode = 1;
      return;
    }
    fs.copyFileSync(path.join(__dirname, 'static/style.css'), path.join(__dirname, 'dist/style.css'));
    const notices = ['vue', 'pinia', 'zod']
      .map(
        name =>
          name +
          '\n' +
          fs.readFileSync(path.join(path.dirname(require.resolve(name + '/package.json')), 'LICENSE'), 'utf8'),
      )
      .join('\n\n----------------\n\n');
    fs.writeFileSync(path.join(__dirname, 'THIRD_PARTY_NOTICES.txt'), notices);
    console.log(stats.toString({ all: false, assets: true, timings: true }));
  },
);
