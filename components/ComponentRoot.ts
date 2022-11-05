declare var ffungit: any;

export class ComponentRoot {
  _apiCache: string;
  defaultDebounceOption = {
    maxWait: 1500,
    leading: false,
    trailing: true
  }

  constructor() { }

  isSamePayload(value: any) {
    const jsonString = JSON.stringify(value);

    if (this._apiCache === jsonString) {
      ffungit.logger.debug(`ignoring redraw for same ${this.constructor.name} payload.`);
      return true;
    }
    ffungit.logger.debug(`redrawing ${this.constructor.name} payload.  \n${jsonString}`);

    this._apiCache = jsonString
    return false;
  }

  clearApiCache() {
    this._apiCache = undefined
  }
}
