/**
 * MP4 demuxer
 */
import {
  Demuxer,
  DemuxerResult,
  PassthroughTrack,
  DemuxedAudioTrack,
  DemuxedUserdataTrack,
  DemuxedMetadataTrack,
  KeyData,
  MetadataSchema,
} from '../types/demuxer';
import {
  findBox,
  segmentValidRange,
  appendUint8Array,
  parseEmsg,
  parseSamples,
  parseInitSegment,
  RemuxerTrackIdConfig,
} from '../utils/mp4-tools';
import { dummyTrack } from './dummy-demuxed-track';
import type { HlsEventEmitter } from '../events';
import type { HlsConfig } from '../config';

const emsgSchemePattern = /\/emsg[-/]ID3/i;

class MP4Demuxer implements Demuxer {
  static readonly minProbeByteLength = 1024;
  private remainderData: Uint8Array | null = null;
  private timeOffset: number = 0;
  private config: HlsConfig;
  private videoTrack?: PassthroughTrack;
  private audioTrack?: DemuxedAudioTrack;
  private id3Track?: DemuxedMetadataTrack;
  private txtTrack?: DemuxedUserdataTrack;

  constructor(observer: HlsEventEmitter, config: HlsConfig) {
    this.config = config;
  }

  public resetTimeStamp() {}

  public resetInitSegment(
    initSegment: Uint8Array,
    audioCodec: string | undefined,
    videoCodec: string | undefined,
    trackDuration: number
  ) {
    const initData = parseInitSegment(initSegment);
    const videoTrack = (this.videoTrack = dummyTrack(
      'video',
      1
    ) as PassthroughTrack);
    const audioTrack = (this.audioTrack = dummyTrack(
      'audio',
      1
    ) as DemuxedAudioTrack);
    const captionTrack = (this.txtTrack = dummyTrack(
      'text',
      1
    ) as DemuxedUserdataTrack);

    this.id3Track = dummyTrack('id3', 1) as DemuxedMetadataTrack;
    this.timeOffset = 0;

    if (initData.video) {
      const { id, timescale, codec } = initData.video;
      videoTrack.id = id;
      videoTrack.timescale = captionTrack.timescale = timescale;
      videoTrack.codec = codec;
    }

    if (initData.audio) {
      const { id, timescale, codec } = initData.audio;
      audioTrack.id = id;
      audioTrack.timescale = timescale;
      audioTrack.codec = codec;
    }

    captionTrack.id = RemuxerTrackIdConfig.text;
    videoTrack.sampleDuration = 0;
    videoTrack.duration = audioTrack.duration = trackDuration;
  }

  public resetContiguity(): void {}

  static probe(data: Uint8Array) {
    // ensure we find a moof box in the first 16 kB
    data = data.length > 16384 ? data.subarray(0, 16384) : data;
    return findBox(data, ['moof']).length > 0;
  }

  public demux(data: Uint8Array, timeOffset: number): DemuxerResult {
    this.timeOffset = timeOffset;
    // Load all data into the avc track. The CMAF remuxer will look for the data in the samples object; the rest of the fields do not matter
    let videoSamples = data;
    const videoTrack = this.videoTrack as PassthroughTrack;
    const textTrack = this.txtTrack as DemuxedUserdataTrack;
    if (this.config.progressive) {
      // Split the bytestream into two ranges: one encompassing all data up until the start of the last moof, and everything else.
      // This is done to guarantee that we're sending valid data to MSE - when demuxing progressively, we have no guarantee
      // that the fetch loader gives us flush moof+mdat pairs. If we push jagged data to MSE, it will throw an exception.
      if (this.remainderData) {
        videoSamples = appendUint8Array(this.remainderData, data);
      }
      const segmentedData = segmentValidRange(videoSamples);
      this.remainderData = segmentedData.remainder;
      videoTrack.samples = segmentedData.valid || new Uint8Array();
    } else {
      videoTrack.samples = videoSamples;
    }

    const id3Track = this.extractID3Track(videoTrack, timeOffset);
    textTrack.samples = parseSamples(timeOffset, videoTrack);

    return {
      videoTrack,
      audioTrack: this.audioTrack as DemuxedAudioTrack,
      id3Track,
      textTrack: this.txtTrack as DemuxedUserdataTrack,
    };
  }

  public flush() {
    const timeOffset = this.timeOffset;
    const videoTrack = this.videoTrack as PassthroughTrack;
    const textTrack = this.txtTrack as DemuxedUserdataTrack;
    videoTrack.samples = this.remainderData || new Uint8Array();
    this.remainderData = null;

    const id3Track = this.extractID3Track(videoTrack, this.timeOffset);
    textTrack.samples = parseSamples(timeOffset, videoTrack);

    return {
      videoTrack,
      audioTrack: dummyTrack() as DemuxedAudioTrack,
      id3Track,
      textTrack: dummyTrack() as DemuxedUserdataTrack,
    };
  }

  private extractID3Track(
    videoTrack: PassthroughTrack,
    timeOffset: number
  ): DemuxedMetadataTrack {
    const id3Track = this.id3Track as DemuxedMetadataTrack;
    if (videoTrack.samples.length) {
      const emsgs = findBox(videoTrack.samples, ['emsg']);
      if (emsgs) {
        emsgs.forEach((data: Uint8Array) => {
          const emsgInfo = parseEmsg(data);
          if (emsgSchemePattern.test(emsgInfo.schemeIdUri)) {
            const pts = Number.isFinite(emsgInfo.presentationTime)
              ? emsgInfo.presentationTime! / emsgInfo.timeScale
              : timeOffset +
                emsgInfo.presentationTimeDelta! / emsgInfo.timeScale;
            const payload = emsgInfo.payload;
            id3Track.samples.push({
              data: payload,
              len: payload.byteLength,
              dts: pts,
              pts: pts,
              type: MetadataSchema.emsg,
            });
          }
        });
      }
    }
    return id3Track;
  }

  demuxSampleAes(
    data: Uint8Array,
    keyData: KeyData,
    timeOffset: number
  ): Promise<DemuxerResult> {
    return Promise.reject(
      new Error('The MP4 demuxer does not support SAMPLE-AES decryption')
    );
  }

  destroy() {}
}

export default MP4Demuxer;
