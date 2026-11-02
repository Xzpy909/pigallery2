import * as express from 'express';
import {AuthenticationMWs} from '../middlewares/user/AuthenticationMWs';
import {RenderingMWs} from '../middlewares/RenderingMWs';
import {VersionMWs} from '../middlewares/VersionMWs';
import {Config} from '../../common/config/private/Config';
import {FileEditMWs} from '../middlewares/FileEditMWs';

/**
 * Create / rename folders and move files. The permission is the one of the upload (Upload.minimumRole).
 */
export class FileEditRouter {
  public static route(app: express.Express): void {
    const auth = [
      AuthenticationMWs.authenticate,
      AuthenticationMWs.authorise(Config.Upload.minimumRole),
    ];
    app.get(
      [Config.Server.apiPath + '/folders/:directory(*)', Config.Server.apiPath + '/folders/'],
      ...auth,
      AuthenticationMWs.normalizePathParam('directory'),
      FileEditMWs.listFolders,
      RenderingMWs.renderResult
    );
    app.post(
      Config.Server.apiPath + '/folders/create',
      ...auth,
      VersionMWs.injectGalleryVersion,
      FileEditMWs.createFolder,
      RenderingMWs.renderResult
    );
    app.post(
      Config.Server.apiPath + '/folders/rename',
      ...auth,
      VersionMWs.injectGalleryVersion,
      FileEditMWs.renameFolder,
      RenderingMWs.renderResult
    );
    app.post(
      Config.Server.apiPath + '/files/move',
      ...auth,
      VersionMWs.injectGalleryVersion,
      FileEditMWs.moveFiles,
      RenderingMWs.renderResult
    );
  }
}
