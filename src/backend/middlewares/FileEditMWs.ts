import {NextFunction, Request, Response} from 'express';
import {ObjectManagers} from '../model/ObjectManagers';
import {ErrorCodes, ErrorDTO} from '../../common/entities/Error';
import {MoveItem} from '../model/FileEditManager';

export class FileEditMWs {

  public static async listFolders(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      req.resultPipe = await ObjectManagers.getInstance().FileEditManager.listFolders(req.params['directory'] || '');
      return next();
    } catch (e) {
      return next(new ErrorDTO(ErrorCodes.UPLOAD_ERROR, (e as Error).message || String(e)));
    }
  }

  public static async createFolder(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (typeof req.body?.name !== 'string' || (req.body.parent !== undefined && typeof req.body.parent !== 'string')) {
      return next(new ErrorDTO(ErrorCodes.INPUT_ERROR, 'parent and name are needed'));
    }
    try {
      req.resultPipe = await ObjectManagers.getInstance().FileEditManager.createFolder(req.body.parent || '', req.body.name);
      return next();
    } catch (e) {
      return next(new ErrorDTO(ErrorCodes.UPLOAD_ERROR, (e as Error).message || String(e)));
    }
  }

  public static async renameFolder(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (typeof req.body?.path !== 'string' || typeof req.body?.name !== 'string') {
      return next(new ErrorDTO(ErrorCodes.INPUT_ERROR, 'path and name are needed'));
    }
    try {
      req.resultPipe = await ObjectManagers.getInstance().FileEditManager.renameFolder(req.body.path, req.body.name);
      return next();
    } catch (e) {
      return next(new ErrorDTO(ErrorCodes.UPLOAD_ERROR, (e as Error).message || String(e)));
    }
  }

  public static async moveFiles(req: Request, res: Response, next: NextFunction): Promise<void> {
    const files = req.body?.files;
    if (!Array.isArray(files) || files.length === 0 || typeof req.body?.target !== 'string' ||
      files.some((f: MoveItem) => typeof f?.name !== 'string' || typeof f?.directory !== 'string')) {
      return next(new ErrorDTO(ErrorCodes.INPUT_ERROR, 'files ({directory, name}[]) and target are needed'));
    }
    try {
      req.resultPipe = await ObjectManagers.getInstance().FileEditManager.moveFiles(files, req.body.target);
      return next();
    } catch (e) {
      return next(new ErrorDTO(ErrorCodes.UPLOAD_ERROR, (e as Error).message || String(e)));
    }
  }
}
