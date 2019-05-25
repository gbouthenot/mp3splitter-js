#!/usr/bin/env node
/* eslint-disable camelcase, no-multiple-empty-lines */

// http://id3.org/id3v2.4.0-frames
// http://id3.org/id3v2-chapters-1.0


const fs = require('fs')


class Cliapp {
  constructor (argv) {
    this.argv = argv
  }

  go () {
    if (this.argv[2] === undefined) {
      console.log(`Usage: node ${this.argv[1]} filetosplit.mp3`)
      process.exit(1)
    }

    const fname = this.argv[2]
    const fileread = new Filereader(fname)

    const mp3splitter = new Mp3splitter(fileread)
    mp3splitter.go()
  }
}


class Filereader {
  constructor (fname) {
    this.fd = fs.openSync(fname, 'r') // throw error if file does not exist

    this.fBufPos = 0
    this.fBufAvail = 0
    this.fBufFilePos = 0
    this.fFilePos = 0
    this.fBuf = new Uint8Array(10 * 1024 * 1024)
  }

  /**
   * advance to next byte and read
   * @return int or false
   */
  getNextByte () {
    if (this.fBufAvail === 0) {
      this.fBufPos = 0
      const read = fs.readSync(this.fd, this.fBuf, this.fBufPos, this.fBuf.length)
      this.fBufAvail = read
      this.fBufFilePos = this.fFilePos
      this.fFilePos += read
    }
    if (this.fBufAvail === 0) {
      return false
    }
    this.fBufAvail--
    return this.fBuf[this.fBufPos++]
  }

  getBytes (n) {
    if (this.fBufAvail < (n - 1)) {
      // console.log('XXX')
      // console.log('n', n)
      // console.log('bufAvail', this.fBufAvail)
      // console.log('bufFilePos', this.fBufFilePos)
      // console.log('bufPos', this.fBufPos)

      this.fBuf = this.fBuf.copyWithin(0, this.fBufPos - 1)
      this.fBufFilePos += this.fBufPos - 1
      this.fBufPos = 1
      const read = fs.readSync(this.fd, this.fBuf, this.fBufAvail + 1, this.fBuf.length - this.fBufAvail - 1)
      this.fBufAvail += read
      this.fFilePos += read
      // console.log('YYY')
      // console.log('bufAvail', this.fBufAvail)
      // console.log('bufFilePos', this.fBufFilePos)
      // console.log('bufPos', this.fBufPos)

      if (this.fBufAvail < (n - 1)) {
        throw new Error('TODO: Buffer too small')
      }
    }
    const retbuf = this.fBuf.slice(this.fBufPos - 1, this.fBufPos + n - 1)
    this.fBufPos += n - 1
    this.fBufAvail -= n - 1
    return retbuf
  }

  rewind (n) {
    this.fBufAvail += n - 1
    this.fBufPos -= n - 1
  }
}


class Id3v2 {
  /**
   * return int or false if not a synchsafe integer
   */
  readSyncsafeInt32 (buf) {
    if (((buf[0] | buf[1] | buf[2] | buf[3]) & 0x80) !== 0) {
      // not a 32 bit synchsafe integer
      return false
    }

    let size = (buf[0] & 0x7f) << 21
    size += (buf[1] & 0x7f) << 14
    size += (buf[2] & 0x7f) << 7
    size += (buf[3] & 0x7f)

    return size
  }

  readInt32 (buf) {
    let size = buf[0] << 24
    size += buf[1] << 16
    size += buf[2] << 8
    size += buf[3]
    return size
  }

  readNTString (buf) {
    const idx = buf.indexOf(0)
    if (idx === -1) {
      throw new Error('Cannot read Null Terminated String')
    }
    return [
      buf.slice(0, idx).reduce((a, b) => a + String.fromCharCode(b), ''),
      buf.slice(idx + 1)
    ]
  }

  readString (buf, len) {
    let str = ''
    for (let i = 0; i < len; i++) {
      str += String.fromCharCode(buf[i])
    }
    return str
  }

  /**
   * Check if buf is a correct Id3v2 header
   * @return false or Object header
   */
  checkHeader (buf) {
    let b0, b1
    const fullheader = {
      raw: buf,
      parsed: {
        version: null,
        size: null,
        totalsize: null,
        flags: {
          unsynch: null,
          extended: null,
          experimental: null,
          footer: null
        }
      }
    }
    const header = fullheader.parsed

    if (buf[0] !== 73 || buf[1] !== 68 || buf[2] !== 51) {
      return false
    }
    // version
    b0 = buf[3]
    b1 = buf[4]
    if (b0 === 255 || b1 === 255) {
      return false
    }
    header.version = `ID3v2.${String.fromCharCode(b0 + 48)}.${String.fromCharCode(b1 + 48)}`

    // abcd0000
    b0 = buf[5]
    if (b0 & 0x0f !== 0) {
      // no 0000
      return false
    }
    header.flags.unsynch = (b0 & 0x80) !== 0
    header.flags.extended = (b0 & 0x40) !== 0
    header.flags.experimental = (b0 & 0x20) !== 0
    header.flags.footer = (b0 & 0x10) !== 0

    header.size = this.readSyncsafeInt32(buf.slice(6, 10))
    if (header.size === false) {
      return false
    }

    header.totalsize = header.size + 10 + header.flags.footer * 10

    return fullheader
  }

  /**
  * Frame:
  * Frame ID      $xx xx xx xx  (four characters)
  * Size      4 * %0xxxxxxx
  * Flags         %0abc0000 %0h00kmnp
  */
  readFrameHeader (buf) {
    let header = {
      raw: buf,
      id: null,
      size: null,
      totalsize: null,
      flags: {
        tagAlterPreservation: null,
        fileAlterPreservation: null,
        readOnly: null,
        groupingIdentity: null,
        compression: null,
        encryption: null,
        unsynchronisation: null,
        dataLengthIndicator: null
      }
    }
    let [b0, b1, b2, b3] = [buf[0], buf[1], buf[2], buf[3]]
    if (!((b0 >= 48 && b0 <= 57) || (b0 >= 65 && b0 <= 90))) { return false }
    if (!((b1 >= 48 && b1 <= 57) || (b1 >= 65 && b1 <= 90))) { return false }
    if (!((b2 >= 48 && b2 <= 57) || (b2 >= 65 && b2 <= 90))) { return false }
    if (!((b3 >= 48 && b3 <= 57) || (b3 >= 65 && b3 <= 90))) { return false }

    header.id = String.fromCharCode(b0, b1, b2, b3)

    header.size = this.readSyncsafeInt32(buf.slice(4, 8))
    if (header.size === false) {
      return false
    }
    header.totalsize = header.size + 10;

    // flags
    [b0, b1] = [buf[8], buf[9]]
    header.flags.tagAlterPreservation = (b0 & 0x40) !== 0
    header.flags.fileAlterPreservation = (b0 & 0x20) !== 0
    header.flags.readOnly = (b0 & 0x10) !== 0
    header.flags.groupingIdentity = (b1 & 0x40) !== 0
    header.flags.compression = (b1 & 0x08) !== 0
    header.flags.encryption = (b1 & 0x04) !== 0
    header.flags.unsynchronisation = (b1 & 0x02) !== 0
    header.flags.dataLengthIndicator = (b1 & 0x01) !== 0

    return header
  }

  /**
   * Parse frame according to header
   * return Object frame
   */
  readFrameData (header, buf) {
    const frame = { header, data: { parsed: null, raw: buf } }
    const id = header.id
    let data
    if (id === 'APIC') {
      data = `(${buf.length} bytes)`
    } else if (id === 'CHAP') {
      data = this.readTagCHAP(buf)
    } else if (id === 'TXXX') {
      // const encoding = buf[0]
      buf = buf.slice(1)
      // TODO: handle UTF-8 and UTF-16 encodings
      data = [];
      [data[0], buf] = this.readNTString(buf)
      data[1] = this.readString(buf, buf.length)
    } else if (id[0] === 'T') {
      // const encoding = buf[0]
      buf = buf.slice(1);
      // TODO: handle UTF-8 and UTF-16 encodings
      [data, buf] = this.readNTString(buf)
    } else {
      // TODO Handle other frames
      console.log(`TAG: ${id}`, buf.reduce((a, b) => b >= 32 && b <= 127 ? a + String.fromCharCode(b) : `${a}%${b.toString(16)} `, ''))
      console.log('raw:', buf.reduce((a, b) => `${a}%${b.toString(16)} `, ''))
    }
    frame.data.parsed = data
    return frame
  }

  readTagCHAP (buf) {
    const data = {
      id: null,
      startTime: null,
      endTime: null,
      subFrames: []
    };
    [data.id, buf] = this.readNTString(buf)
    data.startTime = this.readInt32(buf)
    data.endTime = this.readInt32(buf.slice(4))
    buf = buf.slice(16)
    while (buf.length > 10) {
      const sfheader = this.readFrameHeader(buf)
      const sfdata = buf.slice(10, sfheader.size + 10)
      data.subFrames.push({ id: sfheader.id, data: this.readFrameData(sfheader, sfdata).data.parsed })
      buf = buf.slice(sfheader.size + 10)
    }
    return data
  }

  renderFrame (id, str) {
    const len = str.length + 2 // encoding, string, ending
    const header = [
      id.charCodeAt(0), id.charCodeAt(1), id.charCodeAt(2), id.charCodeAt(3),
      (len & 0xfe00000) >> 21, (len & 0x1fc000) >> 14, (len & 0x3f80) >> 7, len & 0x7f,
      0, 0 // flags
    ]
    const data = [ 0 ] // encoding
    str.split('').forEach(c => {
      data.push(c.charCodeAt())
    })
    data.push(0)

    return { header: { raw: new Uint8Array(header) }, data: { raw: new Uint8Array(data) } }
  }

  renderTag (frames) {
    // render frames
    const rawframes = frames.reduce((buf, frame) => {
      // append raw header and raw data to existing raw
      const b = new Uint8Array(buf.length + frame.header.raw.length + frame.data.raw.length)
      b.set(buf, 0)
      b.set(frame.header.raw, buf.length)
      b.set(frame.data.raw, buf.length + frame.header.raw.length)
      return b
    }, new Uint8Array(0))

    const len = rawframes.length
    const raw = new Uint8Array(10 + len)
    const head = [73, 68, 51, 4] // header ID3v2.4, all flags cleared
    raw.set(head, 0)
    raw[6] = (len & 0xfe00000) >> 21
    raw[7] = (len & 0x1fc000) >> 14
    raw[8] = (len & 0x3f80) >> 7
    raw[9] = len & 0x7f
    raw.set(rawframes, 10)
    return raw
  }
}


class Mp3 {
  getHeader (buf) {
    let b, v, bb, cc

    const header = { raw: buf }
    if (buf[0] !== 0xff) {
      return false
    }

    // AAABBCCD
    b = buf[1]

    // AAA
    if ((b & 0xe0) !== 0xe0) {
      // console.log('AAA is not 111')
      return false
    }

    // BB: MPEG VERSION
    bb = (b & 0x18) >> 3
    if (bb === 1) {
      // console.log('mpeg version reserved')
      return false
    }
    header.mpegVersion = ['2.5', '(reserved)', '2', '1'][bb]
    // console.log(`bb=${bb}: mpeg version ${header.mpegVersion}`)

    // CC: LAYER
    cc = (b & 6) >> 1
    if (cc === 0) {
      // console.log('layer reserved')
      return false
    }
    header.layer = ['(reserved)', 'III', 'II', 'I'][cc]
    // console.log(`cc=${cc}: Layer ${header.layer}`)

    header.samplesPerFrame = [[ // mpeg2.5
      // 0, layer3, layer2, layer 1
    ], [ // reserved
    ], [ // mpeg2
      0, 576, 1152, 384
    ], [ // mpeg1
      0, 1152, 1152, 384
    ]][bb][cc]
    // console.log(`samples per frame=${header.samplesPerFrame}`)

    // D
    header.hasCRC = (b & 1) === 0
    // console.log(`hasCRC: ${header.hasCRC}`)

    // EEEEFFGH
    b = buf[2]

    // EEEE
    v = (b & 0xf0) >> 4
    const bitratesTb = [
      [ 0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 1 ],
      [ 0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 1 ],
      [ 0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 1 ],
      [ 0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 1 ],
      [ 0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 1 ]
    ]
    header.bitrate = bitratesTb[[2, 1, 0, 4, 4, 3][(bb < 3) * 3 + cc - 1]][v]
    // console.log(`eeee: ${v}, bb=${bb}, cc=${cc}: bitrate=${header.bitrate}`)

    // FF
    v = (b & 0xc) >> 4
    if (v === 3) {
      console.log(`ff=${v}, Sampling rate reserved`)
      return false
    }
    const srtb = [[11025, 12000, 8000], [0, 0, 0], [22050, 24000, 16000], [44100, 48000, 32000]]
    header.sampleRate = srtb[bb][v]
    // console.log(`ff=${v}: sample rate=${header.sampleRate}`)

    // G
    header.isPadded = (b & 2) !== 0
    // console.log(`isPadded: ${header.isPadded}`)

    header.frameSize = Math.floor(header.samplesPerFrame * 125 * header.bitrate / header.sampleRate) + header.isPadded
    // console.log(`frameSize=${header.frameSize}`)

    // H (private bit, not used)

    // IIJJKLMM
    b = buf[3]

    // II
    v = (b & 0xc0) >> 10
    header.channelMode = ['Stereo', 'Joint stereo', 'Dual channel', 'Single channel'][v]
    // console.log(`ii=${v}: channelMode=${header.channelMode}`)

    // JJ Joint Stereo extension

    // K Copyright

    // L Original

    // MM: emphasis

    return header
  }
}


// class mp3buffer {
//   constructor () {
//     this.buf = new Uint8Array()
//   }

//   append (arr) {
//     let b
//     if (arr[0] && typeof arr[0].length !== 'undefined') {
//       // push array
//       let newlen = arr.reduce((len, elem) => len + elem.length, this.buf.length)
//       b = new Uint8Array(newlen)
//       b.set(this.buf, 0)
//       arr.reduce((acc, elem) => {
//         b.set(elem, acc)
//         return acc + elem.length
//       }, this.buf.length)
//     } else {
//       b = new Uint8Array(this.buf.length + arr.length)
//       b.set(this.buf, 0)
//       b.set(arr, this.buf.length)
//     }
//     this.buf = b
//     return b
//   }
// }

class U8Array {
  constructor () {
    this.blocks = []
  }

  push (block) {
    this.blocks.push(block)
  }

  render () {
    let newlen = this.blocks.reduce((len, elem) => len + elem.length, 0)
    const buf = new Uint8Array(newlen)
    this.blocks.reduce((acc, elem) => {
      buf.set(elem, acc)
      return acc + elem.length
    }, 0)
    return buf
  }
}

class CurrentFile {
  // this.num : file number (start at 0)
  // this.buf : U8Array
  // this.chap : this chapter
  // this.chaps : all chapters

  constructor (num, chaps) {
    this.num = num
    this.chaps = chaps
    this.chap = chaps[num]
    this.buf = new U8Array()
  }

  push (arr) {
    this.buf.push(arr)
  }

  getFilename () {
    // filename
    const num = this.num + 1
    const tit2 = this.chap.subFrames.find(f => f.id === 'TIT2')
    const numpadded = `00${num}`.slice(-(Math.max(3, num.toString().length)))
    let fn = numpadded
    if (tit2) {
      fn += `-${tit2.data}`
    }
    fn += '.mp3'
    return fn
  }

  /**
   * Create a new file for writing
   * chap: use endtime and subframes
   */
  save () {
    const fn = this.getFilename()

    // save new file
    console.log(`saving ${fn}`)
    const ofd = fs.openSync(fn, 'w')
    fs.writeSync(ofd, this.buf.render())
    fs.closeSync(ofd)
  }
}


class Mp3splitter {
  constructor (fileread) {
    this.infile = fileread
    this.id3v2 = new Id3v2()
    this.mp3 = new Mp3()

    // out file
    this.onum = 0
  }

  go () {
    let b
    const chaps = []
    let chapidx = -1
    let cursample = 0
    let curlsample = -1
    let curFile = null

    const id3frames = { first: [], next: [] }

    while ((b = this.infile.getNextByte()) !== false) {
      // const pos = this.fBufFilePos + this.fBufPos - 1
      // console.log(`testing byte=${b} at ${pos} (0x${pos.toString(16)})`)
      if (b === 73) {
        // Possible ID3V2 header
        // console.log(`possible ID3V2 frame header at ${pos} (0x${pos.toString(16)})`)
        let buf = this.infile.getBytes(10)
        const id3v2header = this.id3v2.checkHeader(buf)
        if (id3v2header) {
          // console.log('ID3V2 HEADER FOUND', id3v2header)

          if (id3v2header.parsed.flags.extended) {
            throw new Error('ID3v2 extended header is not supported')
          }
          let rSize = id3v2header.parsed.size // remaining size

          // read all frames
          while (rSize > 0) {
            b = this.infile.getNextByte()
            if (b === 0) {
              rSize--
              if (id3v2header.parsed.flags.footer) {
                throw new Error('There must be no padding when footer is present !')
              }
            } else {
              buf = this.infile.getBytes(10)
              rSize -= 10
              const frameHeader = this.id3v2.readFrameHeader(buf)
              if (!frameHeader) {
                console.log(buf)
                throw new Error('frame header bad format')
              }
              // console.log('Frame header', frameHeader)

              this.infile.getNextByte()
              buf = this.infile.getBytes(frameHeader.size)
              rSize -= frameHeader.size
              const frame = this.id3v2.readFrameData(frameHeader, buf)
              console.log(frame.header.id, frame.data.parsed)

              if (frameHeader.id === 'CHAP') {
                // not kept, but stored separately
                chaps.push(frame.data.parsed)
              } else if (frameHeader.id === 'APIC') {
                // kept only in first file
                id3frames.first.push(frame)
              } else if (!['TRCK', 'TIT2'].includes(frameHeader.id)) {
                // kept in all files
                id3frames.first.push(frame)
                id3frames.next.push(frame)
              }
            }
          }
        }
      } else if (b === 255) {
        // Possible MP3 frame header

        // const pos = this.fBufFilePos + this.fBufPos - 1
        // console.log(`possible mp3 frame header at ${pos} (0x${pos.toString(16)})`)

        const buf = this.infile.getBytes(4)
        // console.log('buf', buf)

        const mp3header = this.mp3.getHeader(buf)
        if (mp3header) {
          // console.log('MP3 HEADER FOUND', mp3header)
          this.infile.getNextByte()
          const mp3frame = this.infile.getBytes(mp3header.frameSize - 4)

          if (cursample > curlsample && chaps[++chapidx]) {
            if (curFile) {
              curFile.save()
            }

            curFile = new CurrentFile(chapidx, chaps)
            curlsample = chaps[chapidx].endTime * mp3header.sampleRate / 1000
            // fileNbFrames = 0
            // fileNbBytes = 0

            let splFrames // frames for this split

            if (chapidx === 0) {
              splFrames = [ ...id3frames.first ]
            } else {
              splFrames = [ ...id3frames.next ]
            }

            // TODO: move to curFile
            // Add frames 'Tracknumber, 'TotalTracks', 'Track Title'
            splFrames.push(this.id3v2.renderFrame('TRCK', `${chapidx + 1}/${chaps.length}`))
            const tit2 = chaps[chapidx].subFrames.find(f => f.id === 'TIT2')
            if (tit2) {
              splFrames.push(this.id3v2.renderFrame('TIT2', tit2.data))
            }

            // write tag
            const rawid3 = this.id3v2.renderTag(splFrames)
            curFile.push(rawid3)
          }

          curFile.push(mp3header.raw)
          curFile.push(mp3frame)
          cursample += mp3header.samplesPerFrame
          // fileNbFrames++
          // fileNbBytes += mp3header.frameSize
        } else {
          this.infile.rewind(4)
        }
      }
    }
    // EOF
    if (curFile) {
      curFile.save()
    }
  }
}

const cliapp = new Cliapp(process.argv)
cliapp.go()
