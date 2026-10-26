import * as Cesium from 'cesium';
import { overlayHost } from '../app/layers/overlayHost.js';
import { createInfrastructureOverlayEntry } from '../data/infrastructureOverlayEntry.js';
import { governorRequestRender } from '../renderGovernor.js';
import { t } from '../i18n/index.js';
import { STATES, stateSummaries } from './model.js';

const SOURCE = 'open-i-cyber-defence';
/** A private overlay source, with aggregate reports at approximate state references. */
export function createCaseMap(viewer) {
  let visible = false;
  function sync(cases) {
    if (!visible) {
      overlayHost.clearSource(SOURCE);
      governorRequestRender('cyber-defence');
      return;
    }
    overlayHost.setEntries(
      SOURCE,
      stateSummaries(cases).map((row) =>
        createInfrastructureOverlayEntry({
          id: `${SOURCE}:${row.state}`,
          source: SOURCE,
          position: Cesium.Cartesian3.fromDegrees(
            row.point[1],
            row.point[0],
            1000,
          ),
          title: row.state,
          details: [
            t('Open reports: {count}', { count: row.count }),
            t('Approximate state reference; not a person location'),
          ],
          accent: '#55d6e7',
          priority: 20,
        }),
      ),
      { cohortLimit: 37, collisionCapacity: 37, moving: false },
    );
    overlayHost.setVisible(SOURCE, true);
    governorRequestRender('cyber-defence');
  }
  return {
    sync,
    toggle(cases) {
      visible = !visible;
      sync(cases);
      return visible;
    },
    fly(state) {
      const point = STATES[state];
      if (point)
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            point[1],
            point[0],
            600000,
          ),
          duration: 1.5,
        });
    },
    destroy() {
      visible = false;
      overlayHost.clearSource(SOURCE);
      governorRequestRender('cyber-defence-destroy');
    },
  };
}
