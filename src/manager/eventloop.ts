import * as util from '../util'
import { Graph, Cell, State } from '../core'
import { DomEvent, CustomMouseEvent, detector } from '../common'
import { IMouseHandler } from '../handler'
import { RectangleShape } from '../shape'
import { BaseManager } from './manager-base'

export class EventLoop extends BaseManager {
  isMouseDown: boolean = false

  protected mouseListeners: IMouseHandler[]

  protected lastMouseX: number
  protected lastMouseY: number
  protected lastEvent: MouseEvent

  protected lastTouchX: number = 0
  protected lastTouchY: number = 0
  protected lastTouchTime: number = 0
  protected lastTouchCell: Cell | null
  protected lastTouchEvent: MouseEvent

  protected isMouseTrigger: boolean = false
  protected fireDoubleClick: boolean = false
  protected doubleClickCounter: number = 0

  protected eventSource: HTMLElement | null
  protected mouseMoveRedirect: null | ((e: MouseEvent) => void)
  protected mouseUpRedirect: null | ((e: MouseEvent) => void)
  protected ignoreMouseEvents: boolean

  protected tapAndHoldInProgress: boolean = false
  protected tapAndHoldValid: boolean = false
  protected tapAndHoldTimer: number = 0
  protected initialTouchX: number = 0
  protected initialTouchY: number = 0

  constructor(graph: Graph) {
    super(graph)
    this.mouseListeners = []
  }

  addMouseListener(handler: IMouseHandler) {
    if (!this.mouseListeners.includes(handler)) {
      this.mouseListeners.push(handler)
    }
  }

  removeMouseListener(handler: IMouseHandler) {
    if (this.mouseListeners != null) {
      for (let i = 0, ii = this.mouseListeners.length; i < ii; i += 1) {
        if (this.mouseListeners[i] === handler) {
          this.mouseListeners.splice(i, 1)
          break
        }
      }
    }
  }

  protected updateMouseEvent(e: CustomMouseEvent, eventName: string) {
    if (e.graphX == null || e.graphY == null) {
      const x = e.getClientX()
      const y = e.getClientY()
      const p = util.clientToGraph(this.graph.container, x, y)

      e.graphX = p.x - this.graph.panDx
      e.graphY = p.y - this.graph.panDy

      if (
        this.isMouseDown &&
        eventName === DomEvent.MOUSE_MOVE &&
        e.getCell() == null
      ) {
        const ignoreFn = (state: State) => (
          state.shape == null ||
          state.shape.paintBackground !== RectangleShape.prototype.paintBackground ||
          state.style.pointerEvents !== false ||
          !util.isNoneColor(state.shape.fill)
        )

        e.state = this.graph.view.getState(
          this.graph.getCellAt(p.x, p.y, null, false, false, ignoreFn),
        )
      }
    }

    return e
  }

  protected getStateForTouchEvent(e: TouchEvent) {
    const x = DomEvent.getClientX(e)
    const y = DomEvent.getClientY(e)
    const p = util.clientToGraph(this.graph.container, x, y)
    return this.graph.view.getState(this.graph.getCellAt(p.x, p.y))
  }

  protected isEventIgnored(eventName: string, e: CustomMouseEvent, sender: any) {
    const evt = e.getEvent()
    const eventSource = e.getSource()
    const isMouseEvent = DomEvent.isMouseEvent(evt)
    let result = false

    // Drops events that are fired more than once
    if (evt === this.lastEvent) {
      result = true
    } else {
      this.lastEvent = evt
    }

    // Installs event listeners to capture the complete gesture from the
    // event source for non-MS touch events as a workaround for all events
    // for the same geture being fired from the event source even if that
    // was removed from the DOM.
    if (this.eventSource != null && eventName !== DomEvent.MOUSE_MOVE) {

      DomEvent.removeMouseListeners(
        this.eventSource,
        null,
        this.mouseMoveRedirect,
        this.mouseUpRedirect,
      )

      this.eventSource = null
      this.mouseUpRedirect = null
      this.mouseMoveRedirect = null

    } else if (
      !detector.IS_CHROME &&
      this.eventSource != null &&
      this.eventSource !== eventSource
    ) {

      result = true

    } else if (
      detector.SUPPORT_TOUCH &&
      eventName === DomEvent.MOUSE_DOWN &&
      !isMouseEvent &&
      !DomEvent.isPenEvent(evt)
    ) {

      this.eventSource = eventSource
      this.mouseMoveRedirect = (e: MouseEvent) => {
        this.fireMouseEvent(
          DomEvent.MOUSE_MOVE,
          new CustomMouseEvent(e, this.getStateForTouchEvent(e as any)),
          sender,
        )
      }
      this.mouseUpRedirect = (e: MouseEvent) => {
        this.fireMouseEvent(
          DomEvent.MOUSE_UP,
          new CustomMouseEvent(e, this.getStateForTouchEvent(e as any)),
          sender,
        )
      }

      DomEvent.addMouseListeners(
        this.eventSource,
        null,
        this.mouseMoveRedirect,
        this.mouseUpRedirect,
      )
    }

    // Factored out the workarounds for FF to make it easier to override/remove
    // Note this method has side-effects!
    if (this.isSyntheticEventIgnored(eventName, e, sender)) {
      result = true
    }

    // Never fires mouseUp/-Down for double clicks
    if (
      !DomEvent.isPopupTrigger(this.lastEvent) &&
      eventName !== DomEvent.MOUSE_MOVE &&
      this.lastEvent.detail === 2
    ) {
      return true
    }

    // Filters out of sequence events or mixed event types during a gesture
    if (eventName === DomEvent.MOUSE_UP && this.isMouseDown) {
      this.isMouseDown = false
    } else if (eventName === DomEvent.MOUSE_DOWN && !this.isMouseDown) {
      this.isMouseDown = true
      this.isMouseTrigger = isMouseEvent
    } else if (
      !result && ((
        (!detector.IS_FIREFOX || eventName !== DomEvent.MOUSE_MOVE) &&
        this.isMouseDown && this.isMouseTrigger !== isMouseEvent) ||
        (eventName === DomEvent.MOUSE_DOWN && this.isMouseDown) ||
        (eventName === DomEvent.MOUSE_UP && !this.isMouseDown))
    ) {
      // Drops mouse events that are fired during touch gestures
      // as a workaround for Webkit and mouse events that are not
      // in sync with the current internal button state
      result = true
    }

    if (!result && eventName === DomEvent.MOUSE_DOWN) {
      this.lastMouseX = e.getClientX()
      this.lastMouseY = e.getClientY()
    }

    return result
  }

  protected isSyntheticEventIgnored(
    eventName: string,
    e: CustomMouseEvent,
    sender: any,
  ) {
    let result = false
    const isMouseEvent = DomEvent.isMouseEvent(e.getEvent())

    // LATER: This does not cover all possible cases that can go wrong in FF
    if (
      this.ignoreMouseEvents &&
      isMouseEvent &&
      eventName !== DomEvent.MOUSE_MOVE
    ) {
      this.ignoreMouseEvents = eventName !== DomEvent.MOUSE_UP
      result = true
    } else if (
      detector.IS_FIREFOX &&
      !isMouseEvent &&
      eventName === DomEvent.MOUSE_UP
    ) {
      this.ignoreMouseEvents = true
    }

    return result
  }

  protected isEventSourceIgnored(eventName: string, e: CustomMouseEvent) {
    const evt = e.getEvent()
    const elem = e.getSource()
    const nodeName = elem.nodeName ? elem.nodeName.toLowerCase() : ''
    const inputType = (elem as HTMLInputElement).type

    const isLeftMouseButton = (
      !DomEvent.isMouseEvent(evt) ||
      DomEvent.isLeftMouseButton(evt)
    )

    return (
      eventName === DomEvent.MOUSE_DOWN &&
      isLeftMouseButton &&
      (
        nodeName === 'select' ||
        nodeName === 'option' ||
        (
          nodeName === 'input' &&
          inputType !== 'checkbox' &&
          inputType !== 'radio' &&
          inputType !== 'button' &&
          inputType !== 'submit' &&
          inputType !== 'file'
        )
      )
    )
  }

  protected getEventState(state: State | null) {
    return state
  }

  protected consumeMouseEvent(name: string, e: CustomMouseEvent) {
    if (
      name === DomEvent.MOUSE_DOWN &&
      DomEvent.isTouchEvent(e.getEvent())
    ) {
      e.consume(false)
    }
  }

  fireMouseEvent(eventName: string, e: CustomMouseEvent, sender: any) {
    // Ignore left click on some form-input elements.
    if (this.isEventSourceIgnored(eventName, e)) {
      this.graph.hideTooltip()
      return
    }

    // Updates the graph coordinates in the event
    this.updateMouseEvent(e, eventName)

    const evt = e.getEvent()
    const cell = e.getCell()
    const clientX = e.getClientX()
    const clientY = e.getClientY()

    // Detects and processes double taps for touch-based devices
    // which do not have native double click events.
    if (
      (!this.graph.nativeDblClickEnabled && !DomEvent.isPopupTrigger(evt)) ||
      (
        this.graph.doubleTapEnabled && detector.SUPPORT_TOUCH &&
        (DomEvent.isTouchEvent(evt) || DomEvent.isPenEvent(evt))
      )
    ) {
      const currentTime = new Date().getTime()

      if (eventName === DomEvent.MOUSE_DOWN) {
        // mark a double click event
        if (
          this.lastTouchEvent != null &&
          this.lastTouchEvent !== evt &&
          currentTime - this.lastTouchTime < this.graph.doubleTapTimeout &&
          Math.abs(this.lastTouchX - clientX) < this.graph.doubleTapTolerance &&
          Math.abs(this.lastTouchY - clientY) < this.graph.doubleTapTolerance &&
          this.doubleClickCounter < 2
        ) {

          this.doubleClickCounter += 1
          this.fireDoubleClick = true
          this.lastTouchTime = 0

          DomEvent.consume(evt)
          return

        }

        // reset
        if (this.lastTouchEvent == null || this.lastTouchEvent !== evt) {
          this.lastTouchX = clientX
          this.lastTouchY = clientY
          this.lastTouchCell = cell
          this.lastTouchTime = currentTime
          this.lastTouchEvent = evt
          this.doubleClickCounter = 0
        }

      } else if (
        (this.isMouseDown || eventName === DomEvent.MOUSE_UP) &&
        this.fireDoubleClick
      ) {

        const lastTouchCell = this.lastTouchCell

        this.isMouseDown = false
        this.lastTouchCell = null
        this.fireDoubleClick = false

        // Workaround for Chrome/Safari not firing native double click
        // events for double touch on background
        const valid = (lastTouchCell != null) ||
          (
            (DomEvent.isTouchEvent(evt) || DomEvent.isPenEvent(evt)) &&
            (detector.IS_CHROME || detector.IS_SAFARI)
          )

        if (
          valid &&
          Math.abs(this.lastTouchX - clientX) < this.graph.doubleTapTolerance &&
          Math.abs(this.lastTouchY - clientY) < this.graph.doubleTapTolerance
        ) {
          this.dblClick(evt, lastTouchCell)
        } else {
          DomEvent.consume(evt)
        }

        return
      }
    }

    if (this.isEventIgnored(eventName, e, sender)) {
      return
    }

    // Updates the event state via getEventState
    e.state = this.getEventState(e.getState())

    this.graph.trigger(DomEvent.FIRE_MOUSE_EVENT, { eventName, e, sender })

    if (
      detector.IS_OPERA ||
      detector.IS_SAFARI ||
      detector.IS_CHROME ||
      detector.IS_IE11 ||
      detector.IS_IE ||
      evt.target !== this.graph.container
    ) {
      if (
        eventName === DomEvent.MOUSE_MOVE &&
        this.isMouseDown &&
        this.graph.autoScroll &&
        !DomEvent.isMultiTouchEvent(evt)
      ) {

        this.graph.scrollPointToVisible(
          e.getGraphX(),
          e.getGraphY(),
          this.graph.autoExtend,
        )

      } else if (
        eventName === DomEvent.MOUSE_UP &&
        this.graph.ignoreScrollbars &&
        this.graph.translateToScrollPosition &&
        (this.graph.container.scrollLeft !== 0 || this.graph.container.scrollTop !== 0)
      ) {
        const s = this.graph.view.scale
        const tr = this.graph.view.translate
        this.graph.view.setTranslate(
          tr.x - this.graph.container.scrollLeft / s,
          tr.y - this.graph.container.scrollTop / s,
        )
        this.graph.container.scrollLeft = 0
        this.graph.container.scrollTop = 0
      }

      this.mouseListeners && this.mouseListeners.forEach((handler) => {
        if (eventName === DomEvent.MOUSE_DOWN) {
          handler.mouseDown(e, sender)
        } else if (eventName === DomEvent.MOUSE_MOVE) {
          handler.mouseMove(e, sender)
        } else if (eventName === DomEvent.MOUSE_UP) {
          handler.mouseUp(e, sender)
        }
      })

      if (eventName === DomEvent.MOUSE_UP) {
        this.click(e)
      }
    }

    // Detects tapAndHold events using a timer
    if (
      DomEvent.isTouchOrPenEvent(evt) &&
      eventName === DomEvent.MOUSE_DOWN &&
      this.graph.tapAndHoldEnabled &&
      !this.tapAndHoldInProgress
    ) {
      this.initialTouchX = e.getGraphX()
      this.initialTouchY = e.getGraphY()

      if (this.tapAndHoldTimer) {
        window.clearTimeout(this.tapAndHoldTimer)
      }

      this.tapAndHoldTimer = window.setTimeout(
        () => {
          if (this.tapAndHoldValid) {
            this.tapAndHold(e)
          }
          this.tapAndHoldValid = false
          this.tapAndHoldInProgress = false
        },
        this.graph.tapAndHoldDelay,
      )

      this.tapAndHoldValid = true
      this.tapAndHoldInProgress = true

    } else if (eventName === DomEvent.MOUSE_UP) {

      this.tapAndHoldValid = false
      this.tapAndHoldInProgress = false

    } else if (this.tapAndHoldValid) { // hint
      this.tapAndHoldValid =
        Math.abs(this.initialTouchX - e.getGraphX()) < this.graph.tolerance &&
        Math.abs(this.initialTouchY - e.getGraphY()) < this.graph.tolerance
    }

    // Stops editing for all events other than from cellEditor
    if (
      eventName === DomEvent.MOUSE_DOWN &&
      this.graph.isEditing() &&
      !this.graph.cellEditor.isEventSource(evt)
    ) {
      this.graph.stopEditing(!this.graph.isInvokesStopCellEditing())
    }

    this.consumeMouseEvent(eventName, e)
  }

  fireGestureEvent(e: MouseEvent, cell?: Cell) {
    // Resets double tap event handling when gestures take place
    this.lastTouchTime = 0
    this.graph.trigger(Graph.events.gesture, { e, cell })
  }

  escape(e: KeyboardEvent) {
    this.graph.trigger(Graph.events.escape, { e })
  }

  click(e: CustomMouseEvent) {
    const evt = e.getEvent()
    let cell = e.getCell()
    const consumed = e.isConsumed()

    this.graph.trigger(Graph.events.click, { e })

    // Handles the event if it has not been consumed
    if (this.graph.isEnabled() && !DomEvent.isConsumed(evt) && !consumed) {
      if (cell != null) {
        if (this.graph.isTransparentClickEvent(evt)) {
          let active = false

          const tmp = this.graph.getCellAt(
            e.graphX,
            e.graphY,
            null,
            false,
            false,
            (state: State) => {
              const selected = this.graph.isCellSelected(state.cell)
              active = active || selected
              return !active || selected
            },
          )

          if (tmp != null) {
            cell = tmp
          }
        }

        this.graph.selectionManager.selectCellForEvent(cell, evt)
      } else {
        let swimlane = null

        if (this.graph.isSwimlaneSelectionEnabled()) {
          // Gets the swimlane at the location (includes
          // content area of swimlanes)
          swimlane = this.graph.getSwimlaneAt(e.getGraphX(), e.getGraphY())
        }

        // Selects the swimlane and consumes the event
        if (swimlane != null) {
          this.graph.selectionManager.selectCellForEvent(swimlane, evt)
        } else if (!this.graph.isToggleEvent(evt)) {
          // Ignores the event if the control key is pressed
          this.graph.clearSelection()
        }
      }
    }
  }

  dblClick(e: MouseEvent, cell?: Cell | null) {
    this.graph.trigger(Graph.events.dblclick, { e, cell })
    // Handles the event if it has not been consumed
    if (
      this.graph.isEnabled() &&
      !DomEvent.isConsumed(e) &&
      cell != null &&
      this.graph.isCellEditable(cell) &&
      !this.graph.isEditing(cell)
    ) {
      this.graph.startEditingAtCell(cell, e)
      DomEvent.consume(e)
    }
  }

  tapAndHold(e: CustomMouseEvent) {
    const evt = e.getEvent()
    this.graph.trigger(Graph.events.tapAndHold, { e })

    if (DomEvent.isConsumed(evt)) {
      // Resets the state of the panning handler
      this.graph.panningHandler.panningTrigger = false
    }

    // Handles the event if it has not been consumed
    // if (
    //   this.isEnabled() &&
    //   !DomEvent.isConsumed(evt) &&
    //   this.connectionHandler.isEnabled()
    // ) {
    //   const state = this.view.getState(this.connectionHandler.marker.getCell(e))

    //   if (state != null) {
    //     this.connectionHandler.marker.currentColor = this.connectionHandler.marker.validColor
    //     this.connectionHandler.marker.markedState = state
    //     this.connectionHandler.marker.mark()

    //     this.connectionHandler.first = new Point(e.getGraphX(), e.getGraphY())
    //     this.connectionHandler.edgeState = this.connectionHandler.createEdgeState(e)
    //     this.connectionHandler.previous = state
    //     this.connectionHandler.fireEvent(new DomEventObject(DomEvent.START,
    //                     'state', this.connectionHandler.previous))
    //   }
    // }
  }
}
