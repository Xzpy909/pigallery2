import {UserDTO, UserRoles} from '../../../common/entities/UserDTO';
import {UserEntity} from './enitites/UserEntity';
import {SQLConnection} from './SQLConnection';
import {PasswordHelper} from '../PasswordHelper';
import {FindOptionsWhere} from 'typeorm';
import {UserSettingsDTO} from '../../../common/entities/UserSettingsDTO';
import {SearchQueryUtils} from '../../../common/SearchQueryUtils';
import {Config} from '../../../common/config/private/Config';
import {ObjectManagers} from '../ObjectManagers';
import {EncryptionManager} from '../encryption/EncryptionManager';

export class UserManager {


  public async findOne(filter: FindOptionsWhere<UserEntity>): Promise<UserEntity> {
    const connection = await SQLConnection.getConnection();
    const verifyPassword = typeof filter.password == 'string';
    const pass = filter.password as string;
    delete filter.password;
    const user = await connection.getRepository(UserEntity).findOneBy(filter);

    if (verifyPassword && !PasswordHelper.comparePassword(pass, user.password)) {
      throw new Error('No entry found');
    }
    return user;
  }

  public async find(filter: FindOptionsWhere<UserDTO>): Promise<UserEntity[]> {
    const connection = await SQLConnection.getConnection();
    return await connection.getRepository(UserEntity).findBy(filter);
  }

  public async createUser(user: UserDTO): Promise<UserEntity> {
    const connection = await SQLConnection.getConnection();
    // Validate search queries if provided
    if (user.allowQuery) {
      SearchQueryUtils.validateSearchQuery(user.allowQuery, 'User allowQuery');
    }
    if (user.blockQuery) {
      SearchQueryUtils.validateSearchQuery(user.blockQuery, 'User blockQuery');
    }
    SearchQueryUtils.validateDirectoryList(user.allowDirectoryList, 'User allowDirectoryList');
    SearchQueryUtils.validateDirectoryList(user.blockDirectoryList, 'User blockDirectoryList');
    user.password = PasswordHelper.cryptPassword(user.password);
    const ret = await connection.getRepository(UserEntity).save(user);
    ObjectManagers.getInstance().SessionManager.invalidateSessionCache();
    return ret;
  }

  public async deleteUser(id: number): Promise<UserEntity> {
    const connection = await SQLConnection.getConnection();
    const user = await connection.getRepository(UserEntity).findOneBy({id});
    if (user && EncryptionManager.isEnabled() && user.name === EncryptionManager.getUnlockUser()) {
      throw new Error('"' + user.name + '" unlocks the encrypted gallery, it can not be deleted. ' +
        'Decrypt the gallery with the EncryptGallery tool first.');
    }
    const ret = await connection.getRepository(UserEntity).remove(user);
    // ends the sessions of the user and of its sharings
    ObjectManagers.getInstance().SessionManager.invalidateSessionCache();
    return ret;
  }

  public async changeRole(id: number, newRole: UserRoles): Promise<UserEntity> {
    const connection = await SQLConnection.getConnection();
    const userRepository = connection.getRepository(UserEntity);
    const user = await userRepository.findOneBy({id});
    user.role = newRole;
    const ret = await userRepository.save(user);
    ObjectManagers.getInstance().SessionManager.invalidateSessionCache();
    return ret;
  }

  public async setOidcSubject(id: number, oidcSubject: string | null): Promise<UserEntity> {
    const connection = await SQLConnection.getConnection();
    const userRepository = connection.getRepository(UserEntity);
    const user = await userRepository.findOneBy({id});
    if (!user) {
      throw new Error('User not found');
    }
    user.oidcSubject = oidcSubject;
    return userRepository.save(user);
  }

  public async updateSettings(id: number, settings: UserSettingsDTO): Promise<UserEntity> {
    const connection = await SQLConnection.getConnection();
    const userRepository = connection.getRepository(UserEntity);
    const user = await userRepository.findOneBy({id});

    if (!user) {
      throw new Error('User not found');
    }

    if (typeof settings.overrideAllowBlockList !== 'undefined') {
      user.overrideAllowBlockList = settings.overrideAllowBlockList;
    }

    if (typeof settings.allowQuery !== 'undefined') {
      if (settings.allowQuery) {
        SearchQueryUtils.validateSearchQuery(settings.allowQuery, 'User allowQuery');
      }
      user.allowQuery = settings.allowQuery ?? null;
    }

    if (typeof settings.blockQuery !== 'undefined') {
      if (settings.blockQuery) {
        SearchQueryUtils.validateSearchQuery(settings.blockQuery, 'User blockQuery');
      }
      user.blockQuery = settings.blockQuery ?? null;
    }

    if (typeof settings.allowDirectoryList !== 'undefined') {
      SearchQueryUtils.validateDirectoryList(settings.allowDirectoryList, 'User allowDirectoryList');
      user.allowDirectoryList = settings.allowDirectoryList ?? null;
    }

    if (typeof settings.blockDirectoryList !== 'undefined') {
      SearchQueryUtils.validateDirectoryList(settings.blockDirectoryList, 'User blockDirectoryList');
      user.blockDirectoryList = settings.blockDirectoryList ?? null;
    }

    const oldPasswordHash = user.password;
    const rewrapKey = !!settings.newPassword && settings.newPassword.length > 0 &&
      EncryptionManager.isEnabled() && user.name === EncryptionManager.getUnlockUser();
    if (rewrapKey && (EncryptionManager.isLocked() ||
      settings.newPassword.length < EncryptionManager.MIN_PASSWORD_LENGTH)) {
      // the password of this user is the key of the gallery
      throw new Error(EncryptionManager.isLocked() ? 'The gallery is locked.' :
        'The password of "' + user.name + '" is the encryption key of the gallery, use at least ' +
        EncryptionManager.MIN_PASSWORD_LENGTH + ' characters.');
    }

    if (settings.newPassword && settings.newPassword.length > 0) {
      user.password = PasswordHelper.cryptPassword(settings.newPassword);
    }

    const ret = await userRepository.save(user);
    if (rewrapKey) {
      try {
        // the key file has to follow the login password, or the gallery could not be unlocked anymore
        await EncryptionManager.rewrap(settings.newPassword);
      } catch (e) {
        user.password = oldPasswordHash;
        await userRepository.save(user);
        throw e;
      }
    }
    ObjectManagers.getInstance().SessionManager.invalidateSessionCache();
    return ret;
  }

  getUnAuthenticatedUser(): UserDTO {
    return {
      name: UserRoles[Config.Users.unAuthenticatedUserRole],
      role: Config.Users.unAuthenticatedUserRole,
    } as UserDTO;
  }
}
