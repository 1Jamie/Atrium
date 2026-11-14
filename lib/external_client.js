'use strict';

const { referenceDrawerClientSize } = require('./bounds');

/**
 * Map plugin createExternalPane options → lotus createExternalAppPane sizing.
 */
function resolveExternalClientOptions(options, dockWidth, dockHeight) {
  const sizing = options.clientSizing;
  let clientSizing = 'dock';
  let clientWidth = null;
  let clientHeight = null;

  if (sizing === 'reference') {
    const ref = referenceDrawerClientSize(
      options._winForReference,
      options.referenceDrawerOpts || {}
    );
    clientSizing = 'fixed';
    clientWidth = ref.width;
    clientHeight = ref.height;
  } else if (sizing && typeof sizing === 'object' && sizing.width != null && sizing.height != null) {
    clientSizing = 'fixed';
    clientWidth = Math.max(32, Math.floor(Number(sizing.width) || dockWidth));
    clientHeight = Math.max(32, Math.floor(Number(sizing.height) || dockHeight));
  }

  const clientUpscale = options.clientUpscale === 'sgsr' ? 'sgsr' : 'bilinear';

  return {
    clientSizing,
    clientWidth,
    clientHeight,
    clientUpscale,
    clientFollowsDock: clientSizing === 'dock',
  };
}

module.exports = { resolveExternalClientOptions };
