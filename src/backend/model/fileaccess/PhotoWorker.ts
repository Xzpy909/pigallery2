/* eslint-disable @typescript-eslint/no-var-requires */
import sharp from 'sharp';
import {Metadata, Sharp, SharpOptions} from 'sharp';
import {Logger} from '../../Logger';
import {FfmpegCommand, FfprobeData} from 'fluent-ffmpeg';
import {FFmpegFactory} from '../FFmpegFactory';
import * as path from 'path';
import {ExtensionDecorator} from '../extension/ExtensionDecorator';
import {EncryptionManager} from '../encryption/EncryptionManager';


sharp.cache(false);

export class PhotoWorker {
  private static videoRenderer: (input: MediaRendererInput) => Promise<void> = null;

  public static render(input: SvgRendererInput | MediaRendererInput): Promise<void> {
    if (input.type === ThumbnailSourceType.Photo) {
      return this.renderFromImage(input);
    }
    if (input.type === ThumbnailSourceType.Video) {
      return this.renderFromVideo(input as MediaRendererInput);
    }
    throw new Error('Unsupported media type to render thumbnail:' + input.type);
  }

  public static renderFromImage(input: SvgRendererInput | MediaRendererInput, dryRun = false): Promise<void> {
    return ImageRendererFactory.render(input, dryRun);
  }

  public static renderFromVideo(input: MediaRendererInput): Promise<void> {
    if (PhotoWorker.videoRenderer === null) {
      PhotoWorker.videoRenderer = VideoRendererFactory.build();
    }
    return PhotoWorker.videoRenderer(input);
  }
}

export enum ThumbnailSourceType {
  Photo = 1,
  Video = 2,
}

interface RendererInput {
  type: ThumbnailSourceType;
  size: number;
  makeSquare?: boolean;
  outPath?: string;
  quality: number;
  useLanczos3: boolean;
  cut?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export interface MediaRendererInput extends RendererInput {
  mediaPath: string;
  /**
   * Already loaded (e.g.: video frame) source, used instead of reading the mediaPath
   */
  sourceBuffer?: Buffer;
  smartSubsample: boolean;
  sharpOptions: SharpOptions;
  animate: boolean; // animates the output. Used for Gifs
}

export interface SvgRendererInput extends RendererInput {
  svgString: string;
}

export class VideoRendererFactory {
  public static build(): (input: MediaRendererInput) => Promise<void> {
    const ffmpeg = FFmpegFactory.get();

    /**
     * With encryption the thumbnail must never exist as a plain file, not even for a moment.
     * So ffmpeg only sends a frame in a pipe, and it is resized and encrypted in memory.
     */
    const renderEncrypted = async (ffmpegSource: string, input: MediaRendererInput): Promise<void> => {
      const data = await new Promise<FfprobeData>((resolve, reject): void => {
        ffmpeg(ffmpegSource).ffprobe((err: Error, d: FfprobeData): void => {
          return (!!err || d === null) ? reject('[FFmpeg] ' + err) : resolve(d);
        });
      });
      if (!data.streams.some(s => s.width && s.height && !isNaN(s.width) && !isNaN(s.height))) {
        throw new Error('[FFmpeg] Can not read video dimension: ' + input.mediaPath);
      }
      // same as the 10% timemark of the plain thumbnails
      const duration = parseFloat('' + data.format?.duration);
      const seekSeconds = isNaN(duration) ? 0 : duration * 0.1;

      const frame = await new Promise<Buffer>((resolve, reject): void => {
        const chunks: Buffer[] = [];
        const stream = ffmpeg(ffmpegSource)
          .seekInput(seekSeconds)
          .frames(1)
          .noAudio()
          .videoCodec('png')
          .format('image2pipe')
          .on('error', (e: Error): void => reject('[FFmpeg] ' + e.toString()))
          .pipe();
        stream.on('data', (c: Buffer): void => {
          chunks.push(c);
        });
        stream.on('end', (): void => resolve(Buffer.concat(chunks)));
      });
      if (frame.length === 0) {
        throw new Error('[FFmpeg] Can not read a video frame: ' + input.mediaPath);
      }
      await ImageRendererFactory.render({...input, sourceBuffer: frame, animate: false});
    };

    const renderPlain = (ffmpegSource: string, input: MediaRendererInput): Promise<void> => {
      return new Promise((resolve, reject): void => {
        Logger.silly('[FFmpeg] rendering thumbnail: ' + input.mediaPath);

        ffmpeg(ffmpegSource).ffprobe((err: Error, data: FfprobeData): void => {
          if (!!err || data === null) {
            return reject('[FFmpeg] ' + err.toString());
          }

          let width = null;
          let height = null;
          for (const stream of data.streams) {
            if (stream.width && stream.height && !isNaN(stream.width) && !isNaN(stream.height)) {
              width = stream.width;
              height = stream.height;
              break;
            }
          }
          if (!width || !height || isNaN(width) || isNaN(height)) {
            return reject(`[FFmpeg] Can not read video dimension. Found: ${{width}}x${{height}}`);
          }
          const command: FfmpegCommand = ffmpeg(ffmpegSource);
          const fileName = path.basename(input.outPath);
          const folder = path.dirname(input.outPath);
          let executedCmd = '';
          command
            .on('start', (cmd): void => {
              executedCmd = cmd;
            })
            .on('end', (): void => {
              resolve();
            })
            .on('error', (e): void => {
              reject('[FFmpeg] ' + e.toString() + ' executed: ' + executedCmd);
            })
            .outputOptions(['-qscale:v 50']);
          if (input.makeSquare === false) {
            const newSize =
              width < height
                ? Math.min(input.size, width) + 'x?'
                : '?x' + Math.min(input.size, height);
            command.takeScreenshots({
              timemarks: ['10%'],
              size: newSize,
              filename: fileName,
              folder,
            });
          } else {
            command.takeScreenshots({
              timemarks: ['10%'],
              size: input.size + 'x' + input.size,
              filename: fileName,
              folder,
            });
          }
        });
      });
    };

    return async (input: MediaRendererInput): Promise<void> => {
      // encrypted videos are read through a loopback URL, so there is no decrypted copy on the disk
      const source = await EncryptionManager.getFfmpegInput(input.mediaPath);
      try {
        if (EncryptionManager.isEnabled()) {
          await renderEncrypted(source.input, input);
        } else {
          await renderPlain(source.input, input);
        }
      } finally {
        source.release();
      }
    };
  }
}

export class ImageRendererFactory {

  @ExtensionDecorator(e => e.gallery.ImageRenderer.render)
  public static async render(input: MediaRendererInput | SvgRendererInput, dryRun = false): Promise<void> {

    let image: Sharp;
    if ((input as MediaRendererInput).mediaPath) {
      Logger.silly(
        '[SharpRenderer] rendering photo:' +
        (input as MediaRendererInput).mediaPath +
        ', size:' +
        input.size
      );
      // an encrypted photo is decrypted in memory only
      const source = (input as MediaRendererInput).sourceBuffer ||
        await EncryptionManager.getImageSource((input as MediaRendererInput).mediaPath);
      image = sharp(source, {
        failOnError: false,
        animated: (input as MediaRendererInput).animate, ...((input as MediaRendererInput).sharpOptions || {})
      });
    } else {
      const svg_buffer = Buffer.from((input as SvgRendererInput).svgString);
      image = sharp(svg_buffer, {density: 450});
    }
    image.rotate();
    const metadata: Metadata = await image.metadata();
    const kernel =
      input.useLanczos3 === true
        ? sharp.kernel.lanczos3
        : sharp.kernel.nearest;

    if (input.cut) {
      image.extract(input.cut);
    }
    if (input.makeSquare === false) {
      if (metadata.height > metadata.width) {
        image.resize(Math.min(input.size, metadata.width), null, {
          kernel,
        });
      } else {
        image.resize(null, Math.min(input.size, metadata.height), {
          kernel,
        });
      }
    } else {
      image.resize(input.size, input.size, {
        kernel,
        position: sharp.gravity.centre,
        fit: 'cover',
      });
    }
    let processedImg: sharp.Sharp;
    if ((input as MediaRendererInput).mediaPath) {
      processedImg = image.webp({
        effort: 6,
        quality: input.quality,
        smartSubsample: (input as MediaRendererInput).smartSubsample
      });
    } else {
      if ((input as SvgRendererInput).svgString) {
        processedImg = image.png({effort: 6, quality: input.quality});
      }
    }
    // do not save to file
    if (dryRun) {
      await processedImg.toFormat('webp').toBuffer();
      return;
    }
    // Thumbnails of the media are encrypted before they reach the disk.
    // (SVG icons are generated from the config, they have nothing to protect.)
    if (EncryptionManager.isEnabled() && (input as MediaRendererInput).mediaPath) {
      await EncryptionManager.writeFile(input.outPath, await processedImg.toBuffer());
      return;
    }
    await processedImg.toFile(input.outPath);

  }
}
